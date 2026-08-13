// detailCache.js — 24h TTL cache for detail-page data.
//
// Two caches, both in localStorage with a 24-hour TTL:
//
//   related titles — keyword → SearchResult[]
//     Avoids re-fetching the series-works search when the user navigates
//     back to a detail page they already visited.
//
//   detail metadata — source+id → VideoDetail
//     Avoids re-fetching /api/detail (desc, cast, episodes) on repeat
//     visits. Episodes are included in the cached payload, so a 24h TTL
//     means a new episode added on the server appears at most 24h late.
//     This is an acceptable trade-off: the user can always pull-to-refresh
//     (the "重新测速" button already re-probes; a future "refresh detail"
//     could bypass the cache if needed).

import { LocalStore } from "./localStore.js";

const RELATED_KEY = "decotv.cache.related";
const DETAIL_KEY = "decotv.cache.detail";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function now() {
  return Date.now();
}

// Generic read: returns the cached value if within TTL, else null.
// Also prunes the single expired entry on read so storage does not grow
// unbounded with stale entries.
function readCache(storageKey, entryKey) {
  const all = LocalStore.get(storageKey, {}) || {};
  const entry = all[entryKey];
  if (!entry) return null;
  if (now() - entry.t > TTL_MS) {
    delete all[entryKey];
    LocalStore.set(storageKey, all);
    return null;
  }
  return entry.v;
}

// Generic write.
function writeCache(storageKey, entryKey, value) {
  const all = LocalStore.get(storageKey, {}) || {};
  all[entryKey] = { v: value, t: now() };
  LocalStore.set(storageKey, all);
}

// ── Related titles ────────────────────────────────────────────────────────

export function getCachedRelated(keyword) {
  return readCache(RELATED_KEY, keyword);
}

export function setCachedRelated(keyword, results) {
  writeCache(RELATED_KEY, keyword, results);
}

// ── Detail metadata ───────────────────────────────────────────────────────

export function detailCacheKey(source, id) {
  return `${source}+${id}`;
}

export function getCachedDetail(source, id) {
  return readCache(DETAIL_KEY, detailCacheKey(source, id));
}

export function setCachedDetail(source, id, detail) {
  writeCache(DETAIL_KEY, detailCacheKey(source, id), detail);
}
