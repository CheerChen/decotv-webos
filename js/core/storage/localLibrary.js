// localLibrary.js — device-local favorites & play records.
//
// DecoTV in public mode gates its /api/favorites and /api/playrecords behind a
// real account cookie, which a file:// webOS app cannot carry cross-origin
// (see README). This app therefore keeps favorites and play progress on the TV
// itself, in localStorage. The method shapes mirror the DecoTV API client so
// screen code stays identical; keys use the DecoTV `${source}+${id}` convention
// and records use a 1-based `index` (episode number).

import { LocalStore } from "./localStore.js";

const FAVORITES_KEY = "decotv.local.favorites";
const RECORDS_KEY = "decotv.local.playRecords";
const RECORDS_MIGRATED_KEY = "decotv.local.playRecords.migratedVersion";

// Storage schema version — decoupled from app version. Bump this when the
// localStorage format changes and a migration is needed.
export const SCHEMA_VERSION = "2";

function now() {
  return Date.now();
}

export const LocalLibrary = {
  // ── Play-record key ────────────────────────────────────────────────────────
  // Records are keyed by `title|year` (per-movie), NOT by `source+id`. This
  // means switching sources via the 3-pick algorithm overwrites the same
  // record, and "continue watching" resumes by title regardless of which
  // source was originally used.
  recordKeyForTitle(title, year) {
    const t = String(title || "").trim();
    const y = String(year || "").trim();
    return y ? `${t}|${y}` : t;
  },

  // One-time migration: old versions used `source+id` keys. On first launch
  // of the new schema, wipe all play records so stale per-source entries
  // don't linger as orphans. Gated by SCHEMA_VERSION so it only fires once.
  // SCHEMA_VERSION is decoupled from app version — bump it only when a
  // storage format change requires migration.
  migrateRecordsIfNeeded() {
    const migrated = LocalStore.get(RECORDS_MIGRATED_KEY, "");
    if (migrated === SCHEMA_VERSION) return;
    LocalStore.remove(RECORDS_KEY);
    LocalStore.set(RECORDS_MIGRATED_KEY, SCHEMA_VERSION);
  },

  // ── Favorites ─────────────────────────────────────────────────────────────
  // Shape: { "source+id": { cover, title, source_name, total_episodes, search_title, year, save_time } }

  getFavorites(key) {
    const all = LocalStore.get(FAVORITES_KEY, {}) || {};
    if (key) return all[key] || {};
    return all;
  },

  isFavorited(key) {
    const all = LocalStore.get(FAVORITES_KEY, {}) || {};
    return Boolean(all[key]);
  },

  addFavorite(key, favorite) {
    const all = LocalStore.get(FAVORITES_KEY, {}) || {};
    all[key] = { ...favorite, save_time: now() };
    LocalStore.set(FAVORITES_KEY, all);
    return { ok: true };
  },

  deleteFavorite(key) {
    if (!key) { LocalStore.remove(FAVORITES_KEY); return { ok: true }; }
    const all = LocalStore.get(FAVORITES_KEY, {}) || {};
    delete all[key];
    LocalStore.set(FAVORITES_KEY, all);
    return { ok: true };
  },

  // ── Play records ────────────────────────────────────────────────────────
  // Shape: { "title|year": { title, source_name, cover, index(1-based), total_episodes,
  //                         play_time, total_time, year, save_time } }

  getPlayRecords() {
    return LocalStore.get(RECORDS_KEY, {}) || {};
  },

  getPlayRecord(key) {
    const all = this.getPlayRecords();
    return all[key] || null;
  },

  savePlayRecord(key, record) {
    const all = this.getPlayRecords();
    all[key] = { ...all[key], ...record, save_time: now() };
    LocalStore.set(RECORDS_KEY, all);
    return { ok: true };
  },

  deletePlayRecord(key) {
    if (!key) { LocalStore.remove(RECORDS_KEY); return { ok: true }; }
    const all = this.getPlayRecords();
    delete all[key];
    LocalStore.set(RECORDS_KEY, all);
    return { ok: true };
  }
};
