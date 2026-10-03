// workDetails.js — a work's metadata from the catalog that owns it.
//
// The details page shows what the work's own provider says about it
// (summary, rating with its source and vote count, genres, runtime,
// directors, cast names); the DecoTV server's per-source /api/detail only
// fills what the provider left blank. A provider that fails or has nothing
// yields null and the page keeps its source-site metadata — nothing is
// borrowed from another provider.
//
// One request per provider: douban rexxar subject, TMDB {movie|tv}/{id}
// with credits, Bangumi v0 subject. Results are memoised for the session.

import { normalizeWork, workKey } from "./work.js";
import { getSubject as getDoubanSubject } from "../network/doubanDirect.js";
import { tmdb } from "../network/tmdbClient.js";
import { getBangumiSubject } from "../network/bangumiClient.js";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const MAX_CAST = 12;
const MAX_GENRES = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 80;

// Bangumi meta tags that describe the medium or the region rather than the
// work's genre; the region already shows on the card and in the tab.
const BANGUMI_NON_GENRE_TAGS = new Set(["TV", "WEB", "OVA", "OAD", "剧场版", "日本", "中国", "欧美", "美国", "韩国"]);

// TMDB's tv-only combined genres come back in English even with
// language=zh-CN.
const TMDB_GENRE_ZH = {
  "Sci-Fi & Fantasy": "科幻奇幻",
  "Action & Adventure": "动作冒险",
  "War & Politics": "战争政治",
  "Kids": "儿童",
  "News": "新闻",
  "Reality": "真人秀",
  "Soap": "肥皂剧",
  "Talk": "脱口秀",
};

function names(list, max = Infinity) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String((x && (x.name || x.title)) || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

// Providers repeat tags (Bangumi meta tags were seen doubled on device).
function uniqueGenres(list) {
  return [...new Set(list.map((g) => String(g || "").trim()).filter(Boolean))].slice(0, MAX_GENRES);
}

function rating(source, value, votes) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  return { source, value: v.toFixed(1), votes: Number(votes) || 0 };
}

function minutes(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `${v}分钟` : "";
}

export function normalizeDoubanSubject(s) {
  if (!s || !s.id) return null;
  return {
    provider: "douban",
    title: String(s.title || ""),
    year: String(s.year || ""),
    summary: String(s.intro || "").trim(),
    rating: rating("豆瓣", s.rating?.value, s.rating?.count),
    genres: uniqueGenres(s.genres || []),
    duration: String((s.durations || [])[0] || "").replace(/\s+/g, ""),
    episodes: Number(s.episodes_count) || 0,
    directors: names(s.directors),
    cast: names(s.actors, MAX_CAST),
    poster: s.pic?.large || s.pic?.normal || "",
    backdrop: "",
  };
}

export function normalizeTmdbDetails(d, kind) {
  if (!d || !d.id) return null;
  const crew = d.credits?.crew || [];
  const directors = names(crew.filter((c) => c.job === "Director"));
  return {
    provider: "tmdb",
    title: String(d.title || d.name || ""),
    year: String(d.release_date || d.first_air_date || "").slice(0, 4),
    summary: String(d.overview || "").trim(),
    rating: rating("TMDB", d.vote_average, d.vote_count),
    genres: uniqueGenres(names(d.genres).map((g) => TMDB_GENRE_ZH[g] || g)),
    duration: minutes(d.runtime || (d.episode_run_time || [])[0]),
    episodes: kind === "tv" ? Number(d.number_of_episodes) || 0 : 0,
    directors: directors.length ? directors : names(d.created_by),
    cast: names(d.credits?.cast, MAX_CAST),
    poster: d.poster_path ? `${TMDB_IMAGE_BASE}/w500${d.poster_path}` : "",
    backdrop: d.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${d.backdrop_path}` : "",
    // Kept raw for the episode-stills step (season anchoring).
    seasons: kind === "tv" && Array.isArray(d.seasons) ? d.seasons : [],
  };
}

function infoboxValues(infobox, key) {
  const entry = (Array.isArray(infobox) ? infobox : []).find((i) => i && i.key === key);
  if (!entry) return [];
  const v = entry.value;
  if (Array.isArray(v)) return v.map((x) => String(x?.v ?? x ?? "").trim()).filter(Boolean);
  return String(v || "").split(/[、,，/]/).map((x) => x.trim()).filter(Boolean);
}

// Bangumi summaries are often the Chinese translation, a "[简介原文]" line,
// then the Japanese original — the same text twice. Keep the Chinese part.
// Without the marker, drop kana-heavy (Japanese) paragraphs when Chinese
// ones exist; a Japanese-only summary is kept as is (better than none).
const ORIGINAL_MARKER = /^[\[【(（]?\s*(简介原文|原文简介|原文|日文简介)\s*[\]】)）]?[:：]?$/;
const HIRAGANA = /[\u3040-\u309f]/g;
const HAN = /[\u4e00-\u9fff]/g;

// Japanese prose carries hiragana (particles, inflections) in every
// sentence; a Chinese paragraph may quote katakana names but has none.
function japaneseParagraph(p) {
  const hira = (p.match(HIRAGANA) || []).length;
  const han = (p.match(HAN) || []).length;
  return hira >= 3 && hira / Math.max(1, hira + han) >= 0.1;
}

export function chineseSummary(text) {
  const paras = String(text || "").split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  const marker = paras.findIndex((p) => ORIGINAL_MARKER.test(p));
  if (marker > 0) return paras.slice(0, marker).join("\n");
  const rest = marker === 0 ? paras.slice(1) : paras;
  const chinese = rest.filter((p) => !japaneseParagraph(p));
  const hasChinese = chinese.some((p) => (p.match(HAN) || []).length >= 10);
  return (hasChinese ? chinese : rest).join("\n");
}

export function normalizeBangumiSubject(s) {
  if (!s || !s.id) return null;
  const genres = uniqueGenres((s.meta_tags || []).map(String).filter((t) => !BANGUMI_NON_GENRE_TAGS.has(t)));
  return {
    provider: "bangumi",
    title: String(s.name_cn || s.name || ""),
    year: String(s.date || "").slice(0, 4),
    summary: chineseSummary(s.summary),
    rating: rating("Bangumi", s.rating?.score, s.rating?.total),
    genres,
    duration: "",
    episodes: Number(s.total_episodes || s.eps) || 0,
    directors: infoboxValues(s.infobox, "导演"),
    cast: [],
    poster: s.images?.large || s.images?.common || "",
    backdrop: "",
  };
}

const cache = new Map(); // workKey -> { at, value }

async function fetchDetails(work) {
  if (work.provider === "douban") return normalizeDoubanSubject(await getDoubanSubject(work.kind, work.id));
  if (work.provider === "tmdb") return normalizeTmdbDetails(await tmdb.getWorkDetails(work.kind, work.id), work.kind);
  if (work.provider === "bangumi") return normalizeBangumiSubject(await getBangumiSubject(work.id));
  return null;
}

// Never throws: a failed or empty provider answer is null.
export async function getWorkDetails(value, { fetcher = fetchDetails, now = Date.now } = {}) {
  const work = normalizeWork(value);
  if (!work) return null;
  const key = workKey(work);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
  let result = null;
  try {
    result = await fetcher(work);
  } catch (e) {
    console.warn("workDetails:", key, e?.message || e);
    return null;
  }
  if (result) {
    cache.delete(key);
    cache.set(key, { at: now(), value: result });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return result;
}

export function _resetWorkDetailsCache() {
  cache.clear();
}
