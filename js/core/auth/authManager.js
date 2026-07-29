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

// Stored real-user credentials. On this server (AuthMode: public) browsing is
// anonymous, but favorites / play-records require a real session cookie, which
// only a username+password login provides. We persist creds so the cookie can
// be re-obtained silently on every launch and after any 401. Plaintext in
// localStorage is acceptable for a single-owner TV appliance.
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
  _ensuring: null,      // in-flight ensureSession promise (dedupes concurrent 401s)
  subscribers: new Set(),

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  },

  _setState(next, extra) {
    this.state = next;
    this.subscribers.forEach((fn) => fn(next, extra));
  },

  reset() {
    this.serverConfig = null;
  },

  // ── Credential persistence ────────────────────────────────────────────────
  getStoredCredentials() {
    return LocalStore.get(STORAGE_CREDENTIALS, null);
  },

  setStoredCredentials(creds) {
    if (creds && creds.username) LocalStore.set(STORAGE_CREDENTIALS, creds);
    else LocalStore.remove(STORAGE_CREDENTIALS);
  },

  isLoggedIn() {
    return Boolean(this.loggedInUser);
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

  // Prefer the cookie persisted by the Luna service. If it is absent, refresh
  // from stored credentials; public servers can still browse anonymously.
  async _establishSession({ ignorePersisted = false } = {}) {
    try {
      const creds = this.getStoredCredentials();
      if (!ignorePersisted && await api.hasPersistedSession()) {
        this.loggedInUser = creds?.username || null;
        return true;
      }
      if (creds?.password) {
        await api.login(creds.username, creds.password);
        this.loggedInUser = creds.username || null;
        return true;
      }
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
      api.setBaseUrl("");
      LocalStore.remove(STORAGE_BASEURL);
      this._setState(AuthState.NEED_SERVER, { error: this._humanizeError(e) });
    }
  },

  // User submitted username/password (from login screen or settings).
  async loginWithCredentials(username, password) {
    this._setState(AuthState.LOADING);
    try {
      await api.login(username, password);
      this.setStoredCredentials({ username, password });
      this.loggedInUser = username;
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
    try { await api.login(undefined, undefined); } catch (e) { /* browsing still works */ }
    this._setState(AuthState.AUTHENTICATED, { serverConfig: this.serverConfig });
  },

  async logout() {
    try {
      await api.logout();
    } catch (e) { /* best-effort */ }
    // Forget the account but keep the server — drop back to anonymous browsing.
    this.setStoredCredentials(null);
    this.loggedInUser = null;
    if (this.canBrowseAnonymously()) {
      try { await api.login(undefined, undefined); } catch (e) { /* ignore */ }
      this._setState(AuthState.AUTHENTICATED, { serverConfig: this.serverConfig });
      return;
    }
    this._setState(AuthState.NEED_LOGIN, { serverConfig: this.serverConfig });
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
