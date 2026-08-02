// authManager.js — startup state machine for DecoTV.
// Mirrors OrionTV authStore.checkLoginStatus():
//   no apiBaseUrl      → server input screen
//   server-config fail → server input screen (with error)
//   persisted service cookie → authenticated
//   stored credentials       → refresh service cookie
//   public/localstorage      → anonymous login
//   otherwise                → login screen (username + password)
// Any 401 elsewhere → re-run bootstrap.

import { api, STORAGE_BASEURL } from "../network/decotvClient.js";
import { LocalStore } from "../storage/localStore.js";
import { t } from "../i18n.js";

// Stored credentials, keyed by server. Persisting them is what lets the cookie
// be re-obtained silently on every launch and after any 401; plaintext in
// localStorage is an accepted trade for a single-owner TV appliance.
//
// Keyed by server, because they used to be one flat record shared by every
// address: connecting to a newly typed server would POST the previous one's
// password to it before the user had agreed to trust it, and land on the home
// screen if that server happened to answer 200.
const STORAGE_CREDENTIALS = "decotv.credentials";

export const AuthState = {
  LOADING: "loading",
  NEED_SERVER: "need_server",
  NEED_LOGIN: "need_login",
  AUTHENTICATED: "authenticated",
  ERROR: "error"
};

export const AuthManager = {
  state: null,
  serverConfig: null,
  loggedInUser: null,   // real logged-in username, or null when browsing anonymously
  _accountSession: false, // a server-verified account session exists (see hasAccountSession)
  _pendingSwitch: null, // snapshot of the working config while a server switch awaits its first login
  _ensuring: null,      // in-flight ensureSession promise (dedupes concurrent 401s)
  subscribers: new Set(),

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  },

  _setState(next, extra) {
    // Reaching AUTHENTICATED commits a pending server switch: only a session
    // that actually established (credentials or anonymous) replaces the
    // previous working configuration.
    if (next === AuthState.AUTHENTICATED) this._pendingSwitch = null;
    this.state = next;
    this.subscribers.forEach((fn) => fn(next, extra));
  },

  // ── Server switching is a transaction ─────────────────────────────────────
  // Entering the server screen from settings must not touch the working
  // session: the switch only takes effect once a login on the new server
  // completes (AUTHENTICATED commits, see _setState). Backing out anywhere
  // before that restores the snapshot taken here.
  beginServerSwitch() {
    const baseUrl = api.getStoredBaseUrl();
    if (!baseUrl) return; // first run: nothing to preserve
    this._pendingSwitch = {
      baseUrl,
      storedServerConfig: api.getStoredServerConfig(),
      serverConfig: this.serverConfig,
      loggedInUser: this.loggedInUser,
      accountSession: this._accountSession
    };
  },

  // Returns true when an uncommitted switch was rolled back. The service's
  // cookie jar for the previous origin was never touched, so the restored
  // session is still honoured without a new login.
  abortServerSwitch() {
    const snapshot = this._pendingSwitch;
    if (!snapshot) return false;
    this._pendingSwitch = null;
    api.setBaseUrl(snapshot.baseUrl);
    api.setStoredServerConfig(snapshot.storedServerConfig);
    this.serverConfig = snapshot.serverConfig;
    this.loggedInUser = snapshot.loggedInUser;
    this._accountSession = snapshot.accountSession;
    return true;
  },

  // ── Credential persistence ────────────────────────────────────────────────
  _allCredentials() {
    const raw = LocalStore.get(STORAGE_CREDENTIALS, null);
    if (!raw || typeof raw !== "object") return {};
    // Pre-per-server shape: a bare { username, password }. Attribute it to
    // whichever server is configured now, which is the only one it could have
    // been typed for.
    if (typeof raw.username === "string") {
      const current = api.getStoredBaseUrl();
      const migrated = current ? { [current]: raw } : {};
      LocalStore.set(STORAGE_CREDENTIALS, migrated);
      return migrated;
    }
    return raw;
  },

  getStoredCredentials(baseUrl) {
    const url = baseUrl || api.getStoredBaseUrl();
    if (!url) return null;
    return this._allCredentials()[url] || null;
  },

  setStoredCredentials(creds, baseUrl) {
    const url = baseUrl || api.getStoredBaseUrl();
    if (!url) return;
    const all = this._allCredentials();
    if (creds && creds.username) all[url] = creds;
    else delete all[url];
    LocalStore.set(STORAGE_CREDENTIALS, all);
  },

  isLoggedIn() {
    return Boolean(this.loggedInUser);
  },

  // A server-verified account session exists — via the persisted cookie or a
  // credential login — as opposed to browsing anonymously. Distinct from
  // isLoggedIn(): the auth cookie lives in the JS service's own store, not in
  // the webview's localStorage, so the two can diverge — a session can be
  // valid while the stored credentials, and with them the username, are gone.
  // Anything gated on "is there a server-side library to sync with" must use
  // this, not isLoggedIn().
  hasAccountSession() {
    return this._accountSession;
  },

  // Server allows browsing without a real account (public / single-user local).
  canBrowseAnonymously() {
    const storageType = String(this.serverConfig?.StorageType || "").toLowerCase();
    const authMode = String(this.serverConfig?.AuthMode || "").toLowerCase();
    return storageType === "localstorage" || authMode === "public";
  },

  async bootstrap() {
    this._setState(AuthState.LOADING);
    const stored = api.getStoredBaseUrl();
    if (!stored) {
      this._setState(AuthState.NEED_SERVER);
      return;
    }
    api.setBaseUrl(stored);

    // Fast path: use cached server config to skip a network round-trip.
    const cachedCfg = api.getStoredServerConfig();
    if (cachedCfg) {
      this.serverConfig = cachedCfg;
      if (await this._establishSession()) {
        this._setState(AuthState.AUTHENTICATED, { serverConfig: cachedCfg });
        // The cache is here to skip a round trip on launch, not to pin the
        // description of the server forever. Flipping AuthMode server-side
        // otherwise leaves settings reporting the old mode until the user
        // re-enters the address by hand. Refreshed in the background because
        // nothing on screen is waiting for it.
        this._refreshServerConfig();
        return;
      }
      // Cached config could not establish a session → fall through to full connect.
    }

    await this.connect(stored);
  },

  // Neither a stored cookie nor a login that did not throw is proof of a
  // session. The cookie may be expired, or have been issued by a server that
  // has since changed its password; and a public-mode server answers
  // /api/login with `{ok:true}` and no cookie at all whatever it is sent.
  // Taking either as proof is what used to put the app on the home screen with
  // every request 401ing behind it, and with no way to reach the login form.
  // So each candidate session is probed against a per-user endpoint, and only
  // an accepted one counts.
  async _establishSession({ ignorePersisted = false } = {}) {
    this.loggedInUser = null;
    this._accountSession = false;
    try {
      const creds = this.getStoredCredentials();
      if (!ignorePersisted && await api.hasPersistedSession() && await api.verifySession()) {
        // The cookie proves the account session even when the credentials are
        // gone (the service's cookie store and the webview's localStorage are
        // separate stores) — the username is simply unknown then.
        this.loggedInUser = creds?.username || null;
        this._accountSession = true;
        return true;
      }
      if (creds?.password) {
        await api.login(creds.username, creds.password);
        if (await api.verifySession()) {
          this.loggedInUser = creds.username || null;
          this._accountSession = true;
          return true;
        }
      }
      // No account session, but a public server serves browsing anonymously.
      if (this.canBrowseAnonymously()) {
        await api.login(undefined, undefined);
        this.loggedInUser = null;
        return true;
      }
    } catch (e) {}
    return false;
  },

  async _refreshServerConfig() {
    try {
      const cfg = await api.getServerConfig();
      if (!cfg) return;
      this.serverConfig = cfg;
      api.setStoredServerConfig(cfg);
    } catch (e) { /* keep the cached copy — this is best effort */ }
  },

  // User submitted a server URL.
  async connect(url) {
    this._setState(AuthState.LOADING);
    const previous = api.getStoredBaseUrl();
    const normalized = url.replace(/\/+$/, "");
    api.setBaseUrl(normalized);
    try {
      const cfg = await api.getServerConfig();
      this.serverConfig = cfg;
      api.setStoredServerConfig(cfg);
      if (await this._establishSession()) {
        this._setState(AuthState.AUTHENTICATED, { serverConfig: cfg });
        return;
      }
      // Password-mode servers are supported by the bundled JS service.
      this._setState(AuthState.NEED_LOGIN, { serverConfig: cfg });
    } catch (e) {
      // A failed probe of a new address must not destroy the configuration
      // behind it — keep the previous URL so Back (or a retry) still has a
      // working server. Only a first run has nothing to keep.
      api.setBaseUrl(previous || "");
      this._setState(AuthState.NEED_SERVER, { error: this._humanizeError(e) });
    }
  },

  // User submitted username/password (from login screen or settings).
  async loginWithCredentials(username, password) {
    this._setState(AuthState.LOADING);
    try {
      await api.login(username, password);
      // Same reasoning as _establishSession: a 200 from /api/login is not a
      // session. Storing credentials the server will not honour would make
      // every later silent re-auth fail the same way.
      if (!await api.verifySession()) {
        this._setState(AuthState.NEED_LOGIN, { error: t("auth.badCredentials") });
        return;
      }
      this.setStoredCredentials({ username, password });
      this.loggedInUser = username;
      this._accountSession = true;
      const cfg = this.serverConfig || await api.getServerConfig();
      this.serverConfig = cfg;
      this._setState(AuthState.AUTHENTICATED, { serverConfig: cfg });
    } catch (e) {
      this._setState(AuthState.NEED_LOGIN, { error: this._humanizeError(e) });
    }
  },

  // Skip login and browse anonymously (only valid when canBrowseAnonymously()).
  async skipLogin() {
    this._setState(AuthState.LOADING);
    this.loggedInUser = null;
    this._accountSession = false;
    try { await api.login(undefined, undefined); } catch (e) { /* browsing still works */ }
    this._setState(AuthState.AUTHENTICATED, { serverConfig: this.serverConfig });
  },

  // Explicit sign-out: server-side logout + the service's cookie jar for this
  // origin is cleared (api.logout → clearLunaSession), so nothing is left to
  // silently resume from. Lands on the SERVER screen — the root of the gate
  // hierarchy (server → credentials → home) — with the address prefilled, so
  // both "reconnect here" and "somewhere else" start from the same place.
  // Auto-dropping to anonymous browsing made an explicit sign-out look like a
  // half-broken home screen; the login step's "browse only" button remains
  // the explicit way into anonymous mode.
  async logout() {
    try {
      await api.logout();
    } catch (e) { /* best-effort */ }
    this.setStoredCredentials(null);
    this.loggedInUser = null;
    this._accountSession = false;
    this._setState(AuthState.NEED_SERVER, { serverConfig: this.serverConfig });
  },

  // Called by the global 401 interceptor. Silently re-establishes the session
  // WITHOUT navigating — a personal endpoint that 401s while anonymous simply
  // stays failed (the screen shows a "please log in" state) instead of bouncing
  // the user back to the home screen. Concurrent 401s share one attempt.
  async ensureSession() {
    if (this._ensuring) return this._ensuring;
    this._ensuring = (async () => {
      const stored = api.getStoredBaseUrl();
      if (!stored) return false;
      api.setBaseUrl(stored);
      try {
        if (!this.serverConfig) this.serverConfig = api.getStoredServerConfig();
        return await this._establishSession({ ignorePersisted: true });
      } catch (e) {
        return false;
      } finally {
        this._ensuring = null;
      }
    })();
    return this._ensuring;
  },

  _humanizeError(e) {
    const msg = String(e?.message || e || "");
    if (msg === "UNAUTHORIZED") return t("auth.badCredentials");
    if (/Failed to fetch|NetworkError|HTTP 5\d\d/.test(msg)) return t("auth.cannotConnect");
    return msg;
  }
};
