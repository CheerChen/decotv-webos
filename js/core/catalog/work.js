// work.js — catalog identity of a work.
//
// A work belongs to the catalog that listed it: douban, TMDB or Bangumi.
// The details page asks that catalog (the work's provider) for its own
// metadata, whichever catalog the user browses with at the moment.
//
// Shape: { provider: "douban" | "tmdb" | "bangumi", kind: "movie" | "tv" | "", id: "<numeric string>" }
// TMDB numbers movies and tv separately, so its kind is part of the identity;
// douban subjects are typed too (rexxar answers on /movie/ or /tv/ only).
// Ids from different providers overlap numerically and are never compared
// across providers.
//
// Play records and favorites sync with the DecoTV server, whose record
// schema is not ours to extend. The work of a title is therefore kept in a
// local-only map keyed like the records themselves (`title|year`), written
// under both the catalog title and the playing source's title, so continue
// watching and favorites reopen with the same provider.

import { LocalStore } from "../storage/localStore.js";
import { LocalLibrary } from "../storage/localLibrary.js";

export const PROVIDERS = ["douban", "tmdb", "bangumi"];

const WORK_REFS_KEY = "decotv.workRefs";
const WORK_REFS_MAX = 600;

export function makeWork(provider, kind, id) {
  const p = String(provider || "");
  const k = kind === "movie" || kind === "tv" ? kind : "";
  const n = String(id ?? "").trim();
  if (!PROVIDERS.includes(p) || !/^\d+$/.test(n) || n === "0") return null;
  if ((p === "tmdb" || p === "douban") && !k) return null;
  return { provider: p, kind: k, id: n };
}

// Accepts anything shaped like a work (route params, stored JSON) and
// returns a validated copy, or null.
export function normalizeWork(value) {
  if (!value || typeof value !== "object") return null;
  return makeWork(value.provider, value.kind, value.id);
}

export function workKey(work) {
  const w = normalizeWork(work);
  if (!w) return "";
  return w.kind ? `${w.provider}:${w.kind}:${w.id}` : `${w.provider}:${w.id}`;
}

function loadRefs() {
  try {
    const stored = LocalStore.get(WORK_REFS_KEY, null);
    return stored && typeof stored === "object" ? stored : {};
  } catch (_) {
    return {};
  }
}

// Remember which work a title belongs to. Newest entries win; the map is
// capped by insertion order.
export function rememberWork(title, year, work) {
  const w = normalizeWork(work);
  const key = LocalLibrary.recordKeyForTitle(title, year);
  if (!w || !key) return;
  const refs = loadRefs();
  delete refs[key];
  refs[key] = w;
  const keys = Object.keys(refs);
  for (let i = 0; i < keys.length - WORK_REFS_MAX; i++) delete refs[keys[i]];
  try { LocalStore.set(WORK_REFS_KEY, refs); } catch (_) { /* best effort */ }
}

export function lookupWork(title, year) {
  const key = LocalLibrary.recordKeyForTitle(title, year);
  if (!key) return null;
  return normalizeWork(loadRefs()[key]);
}
