// relatedTitles.js — the details page's 系列作品 badges: other seasons and
// derivatives of the same series, found by one server search for the
// series' base title.
//
// Everything compares normalized titles (letters and digits only), because
// resource sites list one season both as "<题名> 第五季" and "<题名>第五季":
// raw comparison showed both as badges, failed to exclude the current
// season, and — when the keyword came from a source title without the
// space — searched for the whole season title and found nothing.

import { normalizeTitle } from "../../../core/network/preferEngine.js";

// A season / part marker at the end of a title.
const SEASON_SUFFIX = /\s*(第[一二三四五六七八九十百零〇\d]+[季部期篇]|season\s*\d+|s\d{1,2})\s*$/i;

const MAX_BADGES = 12;

// Base title to search with: the season marker dropped, then the part
// before the first space. Stable whether or not the title spaces its
// season ("<题名> 第六季" and "<题名>第六季" both give "<题名>").
export function relatedKeyword(title) {
  const t = String(title || "").trim().replace(SEASON_SUFFIX, "").trim();
  const sp = t.search(/\s/);
  return (sp > 0 ? t.slice(0, sp) : t).trim();
}

function episodeCount(r) {
  return Array.isArray(r?.episodes) ? r.episodes.length : 0;
}

// Raw /api/search response → badge candidates: titles starting with the
// keyword, one per normalized title (the listing with most episodes),
// most episodes first, then newest. The current work is excluded at render
// time (excludeRelated), so one cached list serves every season.
export function filterRelatedResults(data, keyword) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const key = normalizeTitle(keyword);
  if (!key) return [];
  const best = new Map();
  for (const r of results) {
    const t = String(r?.title || "").trim();
    const n = normalizeTitle(t);
    if (!n || !n.startsWith(key)) continue;
    // Far longer than the keyword: an unrelated work sharing a prefix.
    if (t.length > keyword.length * 3 + 6) continue;
    const prev = best.get(n);
    if (!prev || episodeCount(r) > episodeCount(prev)) best.set(n, r);
  }
  return [...best.values()].sort((a, b) =>
    (episodeCount(b) - episodeCount(a)) || ((Number(b.year) || 0) - (Number(a.year) || 0))
  ).slice(0, MAX_BADGES);
}

// Drop the work on screen, under any of its titles (card title, source title).
export function excludeRelated(related, currentTitles) {
  const current = new Set((currentTitles || []).map(normalizeTitle).filter(Boolean));
  return (related || []).filter((r) => !current.has(normalizeTitle(r?.title)));
}
