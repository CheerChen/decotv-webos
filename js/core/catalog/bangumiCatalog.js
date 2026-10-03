// bangumiCatalog.js — the anime page's catalog (热门动漫 / 动漫 tabs and the
// home 热门动漫 row), served by Bangumi whichever catalog provider the rest
// of the app uses.
//
// 热门 is Bangumi's trending list (recent collections and discussion, so
// this season leads), at least 100 ratings. It is almost all Japanese (99
// of 100, measured 2026-10), so a region that trending leaves short falls
// back to the public search by heat over the last two years, same floor —
// heat alone is all-time collections and would rank decade-old classics
// first.
//
// The 动漫 tab maps its region / year / sort chips onto the public search.

import { makeWork } from "./work.js";
import { getTrendingAnime, searchAnime } from "../network/bangumiClient.js";

const POOL_TTL_MS = 60 * 60 * 1000;
const POOL_SIZE = 100;
const SEARCH_PAGE = 20;
const RECENT_WINDOW_DAYS = 180;
// 首播时间 has no date sort upstream; heat over a short recent window is the
// closest order ("what just premiered and is being watched").
const PREMIERE_WINDOW_DAYS = 90;
// Score sort needs an audience floor or one-vote 10s lead.
const SCORE_MIN_VOTES = 100;
// 热门 keeps the same floor as the movie charts: a show with a handful of
// ratings is not "hot" yet, however much it is discussed.
const HOT_MIN_VOTES = 100;
// The fallback pool's air-date window. Chinese and western anime rarely
// reach 100 Bangumi ratings soon after airing: within 180 days only 6 / 3
// did, within two years 54 / 27 (measured 2026-10).
const HOT_FALLBACK_WINDOW_DAYS = 730;

function isoDaysAgo(days, now = Date.now()) {
  return new Date(now - days * 86400000).toLocaleDateString("sv-SE");
}

// Chip values → Bangumi region tag. 全部 → no tag.
export function regionTag(value) {
  const v = String(value || "");
  if (v === "华语" || v === "国产" || v === "中国") return ["中国"];
  if (v === "日本") return ["日本"];
  if (v === "欧美") return ["欧美"];
  return [];
}

export function subjectToCard(s) {
  const score = Number(s?.rating?.score) || 0;
  return {
    id: String(s.id),
    title: String(s.name_cn || s.name || ""),
    poster: s.images?.common || s.images?.large || s.images?.medium || "",
    rate: score > 0 ? score.toFixed(1) : "",
    votes: Number(s?.rating?.total) || 0,
    year: String(s.date || "").slice(0, 4),
    work: makeWork("bangumi", "", s.id),
  };
}

// Year chip → air_date predicates (YEAR_OPTIONS values).
export function airDateRange(year) {
  const y = String(year || "");
  if (/^\d{4}$/.test(y)) return [`>=${y}-01-01`, `<=${y}-12-31`];
  const decade = y.match(/^(\d{2,4})年代$/);
  if (decade) {
    let start = Number(decade[1]);
    if (start < 100) start += 1900;
    return [`>=${start}-01-01`, `<=${start + 9}-12-31`];
  }
  if (y === "更早") return ["<=1979-12-31"];
  return [];
}

const pools = new Map(); // region tag key -> { at, cards }

async function recentHeat(tag) {
  const airDate = [`>=${isoDaysAgo(HOT_FALLBACK_WINDOW_DAYS)}`, `<=${isoDaysAgo(0)}`];
  const ratingCount = [`>=${HOT_MIN_VOTES}`];
  const pages = await Promise.all(
    Array.from({ length: POOL_SIZE / SEARCH_PAGE }, (_, i) =>
      searchAnime({ sort: "heat", tag, airDate, ratingCount, limit: SEARCH_PAGE, offset: i * SEARCH_PAGE }))
  );
  const seen = new Set();
  return pages.flatMap((p) => p.data).filter((s) => !seen.has(s.id) && seen.add(s.id));
}

async function hotPool(regionValue, { now = Date.now } = {}) {
  const tag = regionTag(regionValue);
  const key = tag.join("|") || "*";
  const hit = pools.get(key);
  if (hit && now() - hit.at < POOL_TTL_MS) return hit.cards;
  let subjects = [];
  try {
    const trending = (await getTrendingAnime(POOL_SIZE)).filter((s) => s.rating.total >= HOT_MIN_VOTES);
    subjects = tag.length ? trending.filter((s) => s.tags.some((t) => tag.includes(t))) : trending;
  } catch (e) {
    console.warn("bangumi trending unavailable:", e?.message || e);
  }
  if (subjects.length < SEARCH_PAGE) subjects = await recentHeat(tag);
  const cards = subjects.map(subjectToCard).filter((c) => c.title && c.work);
  pools.set(key, { at: now(), cards });
  return cards;
}

// 热门动漫: a slice of the hot pool for the region chip.
export async function getHotAnimePage(regionValue, start = 0, count = SEARCH_PAGE) {
  const cards = await hotPool(regionValue);
  return cards.slice(start, start + count);
}

// 动漫: region / year / sort chips (SORT_OPTIONS values S/U/R/T).
//   S 高分优先  score, ≥100 votes
//   U 近期热度  heat, bounded to the last 180 days unless a year is chosen
//   R 首播时间  heat over the last 90 days (no date sort upstream)
//   T 综合排序  heat over all time. Not "rank": the search endpoint's rank
//               order puts unranked (rank 0) subjects first (seen on device).
export async function getAnimeBrowsePage({ region = "", year = "all", sort = "S" } = {}, start = 0) {
  const tag = regionTag(region);
  const years = airDateRange(year);
  const airDate = [...years, `<=${isoDaysAgo(0)}`];
  let order = "heat";
  let ratingCount = [];
  if (sort === "S") {
    order = "score";
    ratingCount = [`>=${SCORE_MIN_VOTES}`];
  } else if (sort === "R") {
    if (!years.length) airDate.push(`>=${isoDaysAgo(PREMIERE_WINDOW_DAYS)}`);
  } else if (sort === "T") {
    // all-time heat: no window
  } else if (!years.length) {
    // 近期热度 without a year: heat is all-time, so bound it to recent airs.
    airDate.push(`>=${isoDaysAgo(RECENT_WINDOW_DAYS)}`);
  }
  const page = await searchAnime({ sort: order, tag, airDate, ratingCount, limit: SEARCH_PAGE, offset: start });
  return page.data.map(subjectToCard).filter((c) => c.title && c.work);
}

export function _resetBangumiCatalog() {
  pools.clear();
}
