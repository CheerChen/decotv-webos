// librarySync.js — mirror device-local favorites and play records to DecoTV.
//
// Reads stay synchronous everywhere in the UI: localStorage remains the thing
// screens read from, and this module keeps it in step with the server behind
// their backs. Writes go to both, server-side ones fire-and-forget.
//
// The two stores map onto the server differently:
//
//   favorites    local key is already `${source}+${id}`, the server's own
//                convention, so entries pass through unchanged.
//   play records local key is `title|year` (per-movie, so switching sources
//                keeps one resume point) while the server keys per source and
//                rejects anything else. Records are therefore folded on read —
//                grouped by title+year, newest wins — and pushed under the
//                source they were actually watched on.
//
// Once a server has been seeded, it is authoritative: a pull replaces the local
// state so a deletion made on another client actually disappears here. The one
// exception is records saved before this module existed, which carry no
// source/id and so can never be expressed as a server key. Dropping them would
// silently discard watch history, so they are left alone and fade out on their
// own as those titles get watched again.

import { LocalLibrary } from "./localLibrary.js";
import { LocalStore } from "./localStore.js";

const SEEDED_KEY = "decotv.sync.seededServers";
// Consecutive push failures tolerated before the mirror gives up until the next
// successful pull. Progress pushes fire every 10s during playback, so an
// unreachable server must not mean an unbounded stream of doomed requests.
const FAILURE_LIMIT = 3;

// ── Pure helpers (unit tested) ─────────────────────────────────────────────

// A record can only be pushed if it remembers which source it was watched on.
export function isPushableRecord(record) {
  return Boolean(record && record.source && record.id);
}

export function serverRecordKey(record) {
  return `${record.source}+${record.id}`;
}

// Collapse the server's per-source records into the local per-title shape.
// Keys come from the record's own title/year rather than from the server key,
// which is what makes the two schemes reconcilable at all.
export function foldServerRecords(serverRecords) {
  const folded = {};
  for (const [serverKey, record] of Object.entries(serverRecords || {})) {
    if (!record || !record.title) continue;
    const key = LocalLibrary.recordKeyForTitle(record.title, record.year);
    const previous = folded[key];
    if (previous && (previous.save_time || 0) >= (record.save_time || 0)) continue;
    const [source, id] = String(serverKey).split("+");
    folded[key] = { ...record, source, id };
  }
  return folded;
}

// Server-authoritative, minus the legacy carve-out described at the top.
export function applyServerRecords(localRecords, foldedServerRecords) {
  const next = { ...foldedServerRecords };
  for (const [key, record] of Object.entries(localRecords || {})) {
    if (!isPushableRecord(record) && !(key in next)) next[key] = record;
  }
  return next;
}

// Seeding runs once per server, before it becomes authoritative: anything held
// locally that the server does not have yet is uploaded rather than discarded.
export function pickSeedRecords(localRecords, foldedServerRecords) {
  return Object.values(localRecords || {}).filter((record) => {
    if (!isPushableRecord(record)) return false;
    const key = LocalLibrary.recordKeyForTitle(record.title, record.year);
    const remote = (foldedServerRecords || {})[key];
    return !remote || (record.save_time || 0) > (remote.save_time || 0);
  });
}

export function pickSeedFavorites(localFavorites, serverFavorites) {
  return Object.entries(localFavorites || {})
    .filter(([key]) => !(key in (serverFavorites || {})));
}

// The server rejects records missing these, with a 400 that would otherwise
// look like a transport failure and trip the circuit breaker.
export function isAcceptableRecord(record) {
  return Boolean(record && record.title && record.source_name && (record.index || 0) >= 1);
}

// ── Mirror ────────────────────────────────────────────────────────────────

export const LibrarySync = {
  api: null,
  isEnabled: null,   // () => boolean; supplied by the app so this module does
                     // not depend on AuthManager and stays unit-testable
  failures: 0,
  serverBacked: false,
  onPulled: null,    // called after a pull changed local state

  configure({ api, isEnabled, onPulled }) {
    this.api = api;
    this.isEnabled = isEnabled;
    this.onPulled = onPulled;
    this.serverBacked = false;
    this.failures = 0;
  },

  // Having credentials is not the same as having a session. A public-mode
  // server answers /api/login with `{ok:true, mode:"public"}` and no cookie
  // whatever it is sent, so the app can believe it is signed in while every
  // per-user endpoint returns 401. Only a persisted auth cookie proves there
  // is a server-side library to mirror at all, and pull is what establishes
  // it — so nothing is pushed before a pull has succeeded.
  _active() {
    return Boolean(this.api && this.serverBacked && this.isEnabled?.() && this.failures < FAILURE_LIMIT);
  },

  _seededServers() {
    return LocalStore.get(SEEDED_KEY, []) || [];
  },

  _markSeeded(baseUrl) {
    const all = this._seededServers();
    if (all.includes(baseUrl)) return;
    LocalStore.set(SEEDED_KEY, all.concat(baseUrl));
  },

  async pull() {
    if (!this.api || !this.isEnabled?.()) return false;
    const baseUrl = this.api.getStoredBaseUrl();
    if (!baseUrl) return false;
    try {
      if (!await this.api.hasPersistedSession()) {
        this.serverBacked = false;
        return false;
      }
    } catch (e) {
      this.serverBacked = false;
      return false;
    }
    let serverFavorites;
    let serverRecords;
    try {
      [serverFavorites, serverRecords] = await Promise.all([
        this.api.getFavorites(),
        this.api.getPlayRecords()
      ]);
    } catch (e) {
      // Offline or unauthorised: leave local state untouched. Never surface
      // this — browsing works fine without the mirror.
      return false;
    }
    serverFavorites = serverFavorites && typeof serverFavorites === "object" ? serverFavorites : {};
    serverRecords = serverRecords && typeof serverRecords === "object" ? serverRecords : {};
    this.failures = 0;
    this.serverBacked = true;

    const folded = foldServerRecords(serverRecords);
    const localFavorites = LocalLibrary.getFavorites();
    const localRecords = LocalLibrary.getPlayRecords();

    if (!this._seededServers().includes(baseUrl)) {
      // Only hand authority over once every local entry is safely uploaded. A
      // partial seed followed by an authoritative pull would delete exactly the
      // records that failed to upload, which is the one outcome worth being
      // paranoid about. On failure nothing is marked and local state is left
      // as it was, so the next pull tries again.
      if (!await this._seed(localFavorites, localRecords, serverFavorites, folded)) return false;
      this._markSeeded(baseUrl);
      // Re-read rather than reasoning about what the uploads produced.
      return this.pull();
    }

    LocalLibrary.replaceFavorites(serverFavorites);
    LocalLibrary.replaceRecords(applyServerRecords(localRecords, folded));
    try { this.onPulled?.(); } catch (_) {}
    return true;
  },

  // Returns false if anything failed to upload; see the caller.
  async _seed(localFavorites, localRecords, serverFavorites, foldedServerRecords) {
    const favorites = pickSeedFavorites(localFavorites, serverFavorites);
    const records = pickSeedRecords(localRecords, foldedServerRecords);
    for (const [key, favorite] of favorites) {
      try { await this.api.addFavorite(key, favorite); } catch (_) { return false; }
    }
    for (const record of records) {
      // A record the server would reject anyway is not a transport failure.
      // Skipping it is fine: applyServerRecords keeps unpushable entries local.
      if (!isAcceptableRecord(record)) continue;
      try { await this.api.savePlayRecord(serverRecordKey(record), record); } catch (_) { return false; }
    }
    return true;
  },

  _note(ok) {
    this.failures = ok ? 0 : this.failures + 1;
  },

  // All push paths are fire-and-forget: the local write already happened and
  // is what the UI reads, so a failed mirror must never surface as an error.
  pushFavorite(key, favorite) {
    if (!this._active()) return;
    this.api.addFavorite(key, favorite).then(() => this._note(true), () => this._note(false));
  },

  removeFavorite(key) {
    if (!this._active()) return;
    this.api.deleteFavorite(key).then(() => this._note(true), () => this._note(false));
  },

  pushRecord(record) {
    if (!this._active()) return;
    if (!isPushableRecord(record) || !isAcceptableRecord(record)) return;
    this.api.savePlayRecord(serverRecordKey(record), record)
      .then(() => this._note(true), () => this._note(false));
  },

  clearRecords() {
    if (!this._active()) return;
    this.api.deletePlayRecord(null).then(() => this._note(true), () => this._note(false));
  }
};
