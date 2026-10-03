// episodeMeta.js — per-episode stills and official titles from the work's
// own provider, for the details page's episode cards.
//
//   tmdb (tv):  /tv/{id}/season/{n} stills + names, season chosen to follow
//               the playing source (below)
//   bangumi:    /v0/episodes main-story titles, no stills (Bangumi has none)
//   douban, tmdb movies, unknown works: nothing — the page keeps its text
//               episode buttons. No provider borrows another's artwork.
//
// Result: Map<0-based source episode index, { still: url | "", title: string }>.
// Empty map = degrade to text buttons. Never throws.

import { normalizeWork, workKey } from "./work.js";
import { normalizeTitle } from "../network/preferEngine.js";
import { tmdb } from "../network/tmdbClient.js";
import { getBangumiEpisodes } from "../network/bangumiClient.js";

const TMDB_STILL_BASE = "https://image.tmdb.org/t/p/w300";
const MEMO_MAX = 12;
// Long-running series (sites list a decades-old anime as one 1000+ episode
// entry, seen on device) keep the light text buttons: a card rail that long
// is too heavy for a TV, and Bangumi pages its episodes at 100 anyway.
export const MAX_EPISODE_CARDS = 120;

const CN_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

export function chineseNumeral(n) {
  const v = Math.floor(Number(n));
  if (!(v >= 1 && v <= 99)) return String(n);
  if (v < 10) return CN_DIGITS[v];
  const tens = Math.floor(v / 10);
  const ones = v % 10;
  return `${tens === 1 ? "" : CN_DIGITS[tens]}十${CN_DIGITS[ones]}`;
}

// "第 3 季" / "Season 3" / blank say nothing about the season beyond its number.
function genericSeasonName(name) {
  const s = String(name || "").trim();
  return !s || /^第\s*\d+\s*季$/.test(s) || /^第[一二三四五六七八九十]+季$/.test(s) || /^season\s*\d+$/i.test(s);
}

// "第 3 集" / "Episode 3" placeholders are no title at all.
export function genericEpisodeName(name) {
  const s = String(name || "").trim();
  return !s || /^第\s*\d+\s*集$/.test(s) || /^第[一二三四五六七八九十百零]+集$/.test(s) || /^episode\s*\d+$/i.test(s);
}

// The titles a resource site may list a season under. A season with its own
// name is listed by that name; a generic season n>1 as "<show> 第N季", which
// sites spell with a Chinese numeral or a digit.
export function seasonSearchTitles(showName, seasonNumber, seasonName) {
  if (!genericSeasonName(seasonName)) return [String(seasonName).trim()];
  if (Number(seasonNumber) <= 1) return [showName];
  return [`${showName} 第${chineseNumeral(seasonNumber)}季`, `${showName} 第${seasonNumber}季`];
}

// Index (into `seasons`) of the season the playing source is: the season
// whose search title equals the source title; the show's own title is the
// first season; otherwise the season that first aired in the source's year;
// otherwise the first season.
export function anchorSeason(showName, sourceTitle, sourceYear, seasons) {
  const t = normalizeTitle(sourceTitle);
  if (!t || !seasons.length) return 0;
  const byTitle = seasons.findIndex((s) =>
    seasonSearchTitles(showName, s.season_number, s.name).some((q) => normalizeTitle(q) === t));
  if (byTitle >= 0) return byTitle;
  if (normalizeTitle(showName) === t) return 0;
  const year = String(sourceYear || "").trim().slice(0, 4);
  if (!/^\d{4}$/.test(year)) return 0;
  return Math.max(0, seasons.findIndex((s) => String(s.air_date || "").slice(0, 4) === year));
}

// Source episodes are the anchor season's, then the following seasons'
// (sites list a show's later seasons under one entry), flattened in order.
export async function tmdbEpisodeMeta({ showId, showName, seasons, sourceTitle, sourceYear, episodeCount, getSeason }) {
  const usable = (Array.isArray(seasons) ? seasons : [])
    .filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0)
    .sort((a, b) => a.season_number - b.season_number);
  const meta = new Map();
  if (!usable.length || !(episodeCount > 0)) return meta;
  let start = 0;
  for (const season of usable.slice(anchorSeason(showName, sourceTitle, sourceYear, usable))) {
    if (start >= episodeCount) break;
    const data = await getSeason(showId, season.season_number);
    for (const ep of data?.episodes || []) {
      const n = Number(ep.episode_number);
      const flat = start + n - 1;
      if (!(n >= 1) || flat >= episodeCount) break;
      meta.set(flat, {
        still: ep.still_path ? `${TMDB_STILL_BASE}${ep.still_path}` : "",
        title: genericEpisodeName(ep.name) ? "" : String(ep.name).trim(),
      });
    }
    start += Number(season.episode_count);
  }
  return meta;
}

// Source episode i is the i-th main-story episode. Chinese title first,
// then the original title.
export function bangumiEpisodeMeta(episodes, episodeCount) {
  const meta = new Map();
  (episodes || []).slice(0, Math.max(0, episodeCount)).forEach((ep, i) => {
    const title = String(ep?.name_cn || ep?.name || "").trim();
    if (title && !genericEpisodeName(title)) meta.set(i, { still: "", title });
  });
  return meta;
}

const memo = new Map();

// `details` is the work's normalized provider details (workDetails.js);
// `source` is the playing source ({ title, year, episodes }).
export async function loadEpisodeMeta(value, details, source, deps = {}) {
  const work = normalizeWork(value);
  const episodeCount = Array.isArray(source?.episodes) ? source.episodes.length : 0;
  if (!work || episodeCount <= 1 || episodeCount > MAX_EPISODE_CARDS) return new Map();
  if (!(work.provider === "tmdb" && work.kind === "tv") && work.provider !== "bangumi") return new Map();
  const key = `${workKey(work)}|${normalizeTitle(source.title)}|${String(source.year || "").slice(0, 4)}|${episodeCount}`;
  if (memo.has(key)) return memo.get(key);
  let meta = new Map();
  try {
    if (work.provider === "tmdb") {
      if (!details?.seasons?.length) return meta;
      meta = await tmdbEpisodeMeta({
        showId: work.id,
        showName: details.title,
        seasons: details.seasons,
        sourceTitle: source.title,
        sourceYear: source.year,
        episodeCount,
        getSeason: deps.getSeason || ((id, n) => tmdb.getSeason(id, n)),
      });
    } else {
      meta = bangumiEpisodeMeta(await (deps.getEpisodes || getBangumiEpisodes)(work.id), episodeCount);
    }
  } catch (e) {
    console.warn("episodeMeta:", key, e?.message || e);
    return new Map();
  }
  if (meta.size) {
    memo.set(key, meta);
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  return meta;
}

export function _resetEpisodeMetaMemo() {
  memo.clear();
}
