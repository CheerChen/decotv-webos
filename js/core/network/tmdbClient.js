// tmdbClient.js — direct TMDB catalog access for webOS.
//
// Maps the Douban-shaped browse tabs (Chinese genre / region / sort labels,
// chart names) onto TMDB v3 trending / discover / chart endpoints and
// normalizes the results into the same {id,title,poster,rate,votes,year}
// card shape the Douban path produces.
//
// Requests go through the Luna service's fetchTmdb method, which locks them
// to api.themoviedb.org /3/ paths, injects the bundled API key and caches
// responses. The key never reaches this page. Posters are plain
// image.tmdb.org URLs and load through the normal fetchImage pipeline.
//
// Outside webOS (browser preview) there is no service, so every call fails
// and the UI falls back to Douban.

import { LocalStore } from "../storage/localStore.js";
import { hasLunaTransport, lunaTmdbFetch } from "./lunaTransport.js";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const POSTER_SIZE = "w500";

// Builds up to 0.6.x reached TMDB through a LAN sidecar and stored its
// address here; cleared on launch.
const LEGACY_STORAGE_SIDECAR_URL = "decotv.tmdbSidecarUrl";

// ── Mapping tables ────────────────────────────────────────────────────────
// Chinese genre labels (matching Douban's browseConfig) → TMDB genre ids.
// Movie and tv share most ids; differences noted where they diverge.
const GENRE_MAP = {
  // movie + tv shared
  "剧情": 18, "喜剧": 35, "爱情": 10749, "科幻": 878, "悬疑": 9648,
  "动作": 28, "动画": 16, "奇幻": 14, "惊悚": 53, "犯罪": 80,
  "战争": 10752, "历史": 36, "音乐": 10402, "西部": 37,
  // movie-only
  "冒险": 12, "家庭": 10751, "恐怖": 27, "电视电影": 10770,
  // tv-only (id differs from movie)
  "动作冒险": 10759, "儿童": 10762, "新闻": 10763,
  "肥皂剧": 10766,
  // Sci-Fi & Fantasy (tv) — TMDB returns English name for this one in zh-CN
  "Sci-Fi & Fantasy": 10765, "War & Politics": 10768,
  // documentary
  "纪录": 99, "纪录片": 99,
  // show sub-genres (map to tv genres)
  "真人秀": 10764, "脱口秀": 10767, "谈话": 10767,
};

// Chinese region labels (matching Douban) → ISO 3166-1 codes for
// with_origin_country. Douban's "地区" is ambiguous (production country vs
// language); region maps to a country code here and, separately, to an
// original language below.
const REGION_TO_COUNTRY = {
  "全部": "", "华语": "CN|HK|TW", "欧美": "US", "美国": "US", "日本": "JP",
  "韩国": "KR", "中国香港": "HK", "中国台湾": "TW",
  "法国": "FR", "英国": "GB", "印度": "IN",
};
// When Douban region is a language concept, map to original_language.
// zh = Mandarin (mainland/Taiwan), cn = Cantonese (HK) — 华语 needs both,
// and 中国香港 is cn. 欧美 kept for anime/doc sub-lists even though the main
// region list no longer offers it.
const REGION_TO_LANGUAGE = {
  "华语": "zh|cn", "欧美": "en", "美国": "en", "日本": "ja",
  "韩国": "ko", "中国香港": "cn", "中国台湾": "zh",
  "法国": "fr", "英国": "en", "印度": "hi",
};

// Douban sort values → TMDB sort_by.
// S=高分优先, U=近期热度, R=首播时间, T=综合排序.
// Also accepts literal TMDB sort_by values (popularity / vote_average /
// first_air_date) — hot-anime's sort chips send those directly.
const SORT_MAP = {
  S: "vote_average.desc",
  U: "popularity.desc",
  R: "primary_release_date.desc", // movie; tv uses first_air_date.desc
  T: "popularity.desc",
  popularity: "popularity.desc",
  vote_average: "vote_average.desc",
  first_air_date: "first_air_date.desc",
};

// Charts mirror Douban's 热门电影 / 最新电影 / 高分 / 冷门佳片 tabs.
//
// TMDB's native chart endpoints (trending, now_playing, top_rated) accept
// no vote filter, so a 6-vote title can top "trending". Movie charts
// therefore go through /discover with a hard audience floor, reproducing
// the native semantics (measured 2026-10 on device: 17/20 and 18/20 overlap
// with the floor-filtered native lists, one request per page):
//   热门电影  popularity, released within the last year
//   最新电影  theatrical release (types 2|3) in the last 45 days — the
//            same rule TMDB documents for /movie/now_playing
// TV 热门 keeps /trending/tv/week (discover/tv ranks long-running talk
// shows and decades-old sitcoms first) and filters it client-side.
const CHART_VOTE_FLOOR = 100;
const HOT_MOVIE_WINDOW_DAYS = 365;
const LATEST_MOVIE_WINDOW_DAYS = 45;

// TV 热门 filters, both regions: no animation (its own tab), no talk /
// news / reality / soap (variety tab or not series at all).
const HOT_TV_EXCLUDED_GENRES = [16, 10767, 10763, 10764, 10766];
// 欧美 for TV: TMDB has too few votes on CN/JP/KR series for a floor to
// leave anything current, so the TMDB TV tab offers only 全部 / 欧美.
const HOT_TV_WEST_COUNTRIES = "US|GB|CA|AU|FR|DE|ES|IT|SE|DK|NO";
const HOT_TV_WEST_WINDOW_DAYS = 730;

// Client-side filtering of trending: each external page pulls upstream
// pages until 20 survivors (measured: ~2.6 upstream pages per page at the
// 100-vote floor). The cap bounds a pathological upstream; a short page
// then ends auto-load. Results are kept per session for TRENDING_TTL_MS
// so page N+1 continues where page N stopped.
const TRENDING_MAX_FETCHES_PER_PAGE = 8;
const TRENDING_TTL_MS = 30 * 60 * 1000;

// Vote-count floor for rating / popularity sorts, stepped down until a page
// fills. A fixed 500 starves narrow filters (this year + 日本 + 高分优先 → 0
// items); 5 is the safety net that still blocks 1-2 vote junk.
const VOTE_FLOOR_STEPS = [500, 200, 80, 30, 10, 5];
const PAGE_TARGET = 20;

// Poster localization: one /images call per item, bounded fan-out. The
// picked path is persisted so revisits and relaunches skip the call.
const POSTER_CONCURRENCY = 6;
const POSTER_PICKS_KEY = "decotv.tmdbPosterPicks";
const POSTER_PICKS_MAX = 1500;

// ── Pure helpers (exported for tests) ─────────────────────────────────────

// labelStr can be comma-separated (AND) or pipe-separated (OR):
// "动作,喜剧" → "28,35", "动作|喜剧" → "28|35". Raw numeric ids
// ("16", "10764,99") pass through unchanged — browseConfig's genrePreset
// sends those directly.
export function translateGenres(labelStr) {
  const labels = String(labelStr || "").split(/[,|]/);
  if (labels.every((l) => /^\d+$/.test(l.trim()))) return labelStr;
  const ids = labels.map((l) => GENRE_MAP[l.trim()]).filter(Boolean);
  if (ids.length === 0) return "";
  if (labelStr.includes("|") && !labelStr.includes(",")) return ids.join("|");
  return ids.join(",");
}

// "<题名> 1/2/3" occupy three slots on the same chart. For curated lists
// collapse a franchise to its single highest-rated entry by comparing a
// normalized "base title" (subtitle after ：/:/— dropped, trailing
// 第N部/第N季/II/III/(year)/bare number/3D dropped).
export function seriesBaseTitle(title) {
  let t = String(title || "").trim();
  t = t.split(/[：:]|\s-\s/)[0].trim();
  t = t.replace(/\s*第[一二三四五六七八九十百千0-9]+[部季集篇]?\s*$/, "");
  t = t.replace(/\s*[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*$/, "");
  t = t.replace(/\s*\(\d{4}\)\s*$/, "");
  // Only strip a trailing number when something remains, so pure-numeric
  // titles keep their identity.
  const stripped = t.replace(/\s*\d+\s*$/, "").replace(/\s*3D\s*$/i, "");
  if (stripped.trim()) t = stripped;
  return t.trim();
}

export function dedupeSeries(list) {
  const best = new Map();
  const singles = [];
  for (const item of list) {
    const key = seriesBaseTitle(item.title);
    if (!key) { singles.push(item); continue; }
    const prev = best.get(key);
    if (!prev || Number(item.rate) > Number(prev.rate)) best.set(key, item);
  }
  return [...singles, ...best.values()];
}

// zh-CN is "sparse" when the first 3 items all lack a title.
function hasMeaningfulResults(data) {
  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) return true;
  return results.slice(0, 3).some((x) => (x.title || x.name || "").trim());
}

function mergeLanguageFallback(zh, en) {
  if (!en?.results) return zh;
  const enById = new Map(en.results.map((x) => [x.id, x]));
  return {
    ...zh,
    results: zh.results.map((x) => {
      const enX = enById.get(x.id);
      if (!enX) return x;
      return {
        ...enX,
        ...x,
        title: x.title || enX.title || enX.name || "",
        name: x.name || enX.name || "",
        overview: x.overview || enX.overview || "",
        poster_path: x.poster_path || enX.poster_path,
      };
    }),
  };
}

function posterLangOf(lang) {
  const known = ["zh", "ja", "ko", "en", "fr", "de", "es", "it", "ru", "th", "hi", "pt", "nl"];
  return known.includes(lang) ? lang : "en";
}

// Prefer the item's original language, highest-voted poster in it (TMDB
// lists several per language; first-match picks a low-vote duplicate).
export function pickPoster(posters, originalLanguage) {
  const list = Array.isArray(posters) ? posters : [];
  const lang = posterLangOf(originalLanguage);
  const byLang = list.filter((p) => p.iso_639_1 === lang && p.file_path);
  const any = list.filter((p) => p.iso_639_1 && p.file_path);
  const pool = byLang.length ? byLang : any;
  const pick = pool.length
    ? pool.reduce((best, p) => (Number(p.vote_average) > Number(best.vote_average) ? p : best))
    : list[0];
  return pick?.file_path || "";
}

function isoDaysAgo(days, now = Date.now()) {
  return new Date(now - days * 86400000).toLocaleDateString("sv-SE");
}

// Survives the trending floor: enough votes, already released, a genre the
// tab carries.
export function keepTrendingTv(item, today, floor = CHART_VOTE_FLOOR) {
  if ((item.vote_count || 0) < floor) return false;
  const date = item.first_air_date || item.release_date || "";
  if (date && date > today) return false;
  return !(item.genre_ids || []).some((id) => HOT_TV_EXCLUDED_GENRES.includes(id));
}

function mapConcurrent(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  return Promise.all(Array.from({ length: n }, worker)).then(() => results);
}

function tmdbError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// ── Client ────────────────────────────────────────────────────────────────

export class TmdbClient {
  // `transport(path)` resolves to the raw JSON text of a TMDB /3/ path;
  // injectable for tests.
  constructor({ transport } = {}) {
    this._transport = transport || null;
    this._posterPicks = null; // lazy-loaded Map "mt:id" -> file_path
    this._trendingTv = null;  // filtered trending state, see _hotTvPage
  }

  // Drop the address a pre-removal build stored for the TMDB sidecar.
  clearLegacyStorage() {
    try {
      if (LocalStore.get(LEGACY_STORAGE_SIDECAR_URL, null) !== null) {
        LocalStore.remove(LEGACY_STORAGE_SIDECAR_URL);
      }
    } catch (_) { /* storage unavailable: nothing to clear */ }
  }

  async _send(path) {
    if (this._transport) return this._transport(path);
    if (!hasLunaTransport()) throw tmdbError(0, "TMDB_UNAVAILABLE");
    const response = await lunaTmdbFetch(path, { timeoutMs: 12000 });
    if (!response.ok) throw tmdbError(response.status, `TMDB upstream returned ${response.status}`);
    return response.text();
  }

  async _get(endpoint, params = {}) {
    const query = new URLSearchParams();
    query.set("language", "zh-CN");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
    }
    const text = await this._send(`/3${endpoint}?${query}`);
    return JSON.parse(text);
  }

  // zh-CN first; sparse zh results are completed from en-US, and a failed
  // zh request retries once in en-US.
  async _getWithFallback(endpoint, params = {}) {
    let zh;
    try {
      zh = await this._get(endpoint, params);
    } catch (e) {
      if (e?.status >= 500 || e?.message === "TIMEOUT") {
        return this._get(endpoint, { ...params, language: "en-US" });
      }
      throw e;
    }
    if (hasMeaningfulResults(zh)) return zh;
    const en = await this._get(endpoint, { ...params, language: "en-US" });
    return mergeLanguageFallback(zh, en);
  }

  // ── Poster localization ──────────────────────────────────────────────────

  _picks() {
    if (!this._posterPicks) {
      let stored = null;
      try { stored = LocalStore.get(POSTER_PICKS_KEY, null); } catch (_) { stored = null; }
      this._posterPicks = new Map(Array.isArray(stored) ? stored : []);
    }
    return this._posterPicks;
  }

  _rememberPick(key, path) {
    const picks = this._picks();
    picks.delete(key);
    picks.set(key, path);
    while (picks.size > POSTER_PICKS_MAX) picks.delete(picks.keys().next().value);
    this._picksDirty = true;
  }

  _persistPicks() {
    if (!this._picksDirty) return;
    this._picksDirty = false;
    try { LocalStore.set(POSTER_PICKS_KEY, Array.from(this._picks())); } catch (_) { /* best effort */ }
  }

  async _localizedPosterPath(mediaType, id, originalLanguage) {
    const key = `${mediaType}:${id}`;
    const picks = this._picks();
    if (picks.has(key)) return picks.get(key);
    try {
      const data = await this._get(`/${mediaType}/${id}/images`, {
        include_image_language: "zh,ja,ko,en,null",
        language: "en-US",
      });
      const path = pickPoster(data?.posters, originalLanguage);
      this._rememberPick(key, path);
      return path;
    } catch (_) {
      return "";
    }
  }

  async _normalizeItem(item, mediaType) {
    const title = item.title || item.name || "";
    const date = item.release_date || item.first_air_date || "";
    const mt = item.media_type || (mediaType !== "all" ? mediaType : "") ||
      (item.first_air_date ? "tv" : "movie");
    const localized = await this._localizedPosterPath(mt, item.id, item.original_language);
    const posterPath = localized || item.poster_path || "";
    return {
      id: String(item.id),
      title,
      poster: posterPath ? `${TMDB_IMAGE_BASE}/${POSTER_SIZE}${posterPath}` : "",
      rate: item.vote_average ? Number(item.vote_average).toFixed(1) : "",
      votes: item.vote_count || 0,
      year: date.slice(0, 4),
      _tmdb_id: item.id,
      _media_type: mt,
      _date: date,
    };
  }

  async _normalizeResults(results, mediaType) {
    const list = await mapConcurrent(
      results,
      (item) => this._normalizeItem(item, mediaType),
      POSTER_CONCURRENCY
    );
    this._persistPicks();
    return list;
  }

  async _normalizeList(data, mediaType) {
    const list = await this._normalizeResults(data?.results || [], mediaType);
    return {
      list,
      total: data?.total_results || list.length,
      page: data?.page || 1,
      total_pages: data?.total_pages || 1,
    };
  }

  // ── Catalog ──────────────────────────────────────────────────────────────

  // Charts. Movie: hot / latest / top_rated / hidden_gems. TV: hot only,
  // with opts.region "" (全部) or "欧美".
  async getChart(mediaTypeArg, chart = "hot", page = 1, opts = {}) {
    page = Number(page) || 1;
    if (mediaTypeArg === "tv") {
      if (chart !== "hot") throw tmdbError(400, `Unknown tv chart: ${chart}`);
      return opts.region === "欧美" ? this._hotTvWest(page) : this._hotTvPage(page);
    }
    const today = isoDaysAgo(0);
    const endpoint = "/discover/movie";
    let params;
    if (chart === "hot") {
      params = {
        sort_by: "popularity.desc",
        "vote_count.gte": CHART_VOTE_FLOOR,
        "primary_release_date.gte": isoDaysAgo(HOT_MOVIE_WINDOW_DAYS),
        "primary_release_date.lte": today,
      };
    } else if (chart === "latest") {
      params = {
        sort_by: "popularity.desc",
        "vote_count.gte": CHART_VOTE_FLOOR,
        with_release_type: "2|3",
        "release_date.gte": isoDaysAgo(LATEST_MOVIE_WINDOW_DAYS),
        "release_date.lte": today,
      };
    } else if (chart === "top_rated") {
      // vote_average.desc with a real audience floor — the native
      // top_rated endpoint ranks 1-vote 10.0s first.
      params = { sort_by: "vote_average.desc", "vote_count.gte": 500 };
    } else if (chart === "hidden_gems") {
      // 冷门佳片 is "highly rated but underexposed", not low-vote
      // obscurities: a 20-500 vote window surfaced concert films, docs and
      // English-only shorts no Chinese resource site carries. The working
      // window keeps a real audience (500-5000 votes), drops concerts/docs
      // (10402,99) and excludes recent releases (inflated scores, no source
      // has them yet). Language window mirrors what source sites cover.
      params = {
        sort_by: "vote_average.desc",
        "vote_average.gte": 7.5,
        "vote_count.gte": 500,
        "vote_count.lte": 5000,
        without_genres: "10402,99",
        with_original_language: "zh|ja|ko|en|fr|de|es",
        "primary_release_date.lte": "2024-12-31",
      };
    } else {
      throw tmdbError(400, `Unknown chart: ${chart}`);
    }
    const normalized = await this._normalizeList(
      await this._getWithFallback(endpoint, { ...params, page }),
      "movie"
    );
    if (chart === "hidden_gems") normalized.list = dedupeSeries(normalized.list);
    return normalized;
  }

  // TV 热门 / 欧美: recent western series, popularity, hard floor.
  async _hotTvWest(page) {
    const data = await this._getWithFallback("/discover/tv", {
      sort_by: "popularity.desc",
      "vote_count.gte": CHART_VOTE_FLOOR,
      with_origin_country: HOT_TV_WEST_COUNTRIES,
      without_genres: HOT_TV_EXCLUDED_GENRES.join(","),
      "first_air_date.gte": isoDaysAgo(HOT_TV_WEST_WINDOW_DAYS),
      "first_air_date.lte": isoDaysAgo(0),
      page,
    });
    return this._normalizeList(data, "tv");
  }

  // TV 热门 / 全部: /trending/tv/week filtered by keepTrendingTv. Survivors
  // accumulate in order; external page N is survivors [20(N-1), 20N). A
  // fresh page 1 after the TTL restarts from upstream page 1 (the ranking
  // moves; mid-session pages stay consistent with what is on screen).
  async _hotTvPage(page) {
    const now = Date.now();
    let st = this._trendingTv;
    if (!st || (page === 1 && now - st.createdAt > TRENDING_TTL_MS)) {
      st = this._trendingTv = {
        createdAt: now, kept: [], seen: new Set(),
        nextUpstream: 1, totalPages: 1, totalResults: 0, scanned: 0, exhausted: false,
      };
    }
    const today = isoDaysAgo(0);
    const want = page * PAGE_TARGET;
    let fetches = 0;
    while (st.kept.length < want && !st.exhausted && fetches < TRENDING_MAX_FETCHES_PER_PAGE) {
      fetches += 1;
      const data = await this._getWithFallback("/trending/tv/week", { page: st.nextUpstream });
      const results = data?.results || [];
      st.totalPages = data?.total_pages || st.totalPages;
      st.totalResults = data?.total_results || st.totalResults;
      st.scanned += results.length;
      for (const item of results) {
        if (st.seen.has(item.id)) continue;
        st.seen.add(item.id);
        if (keepTrendingTv(item, today)) st.kept.push(item);
      }
      st.nextUpstream += 1;
      if (results.length === 0 || st.nextUpstream > st.totalPages) st.exhausted = true;
    }
    const slice = st.kept.slice((page - 1) * PAGE_TARGET, want);
    const list = await this._normalizeResults(slice, "tv");
    // total drives auto-load eligibility (>= 100): exact once exhausted,
    // otherwise the upstream total scaled by the observed survival rate.
    const total = st.exhausted || !st.scanned
      ? st.kept.length
      : Math.max(st.kept.length, Math.round(st.totalResults * st.kept.length / st.scanned));
    return { list, total, page, total_pages: Math.ceil(total / PAGE_TARGET) || 1 };
  }

  // Discover with semantic filters (Douban-compatible labels):
  //   genre      剧情|喜剧|... or raw ids (comma = AND, pipe = OR)
  //   region     华语|美国|...
  //   language   explicit original-language filter (overrides region's)
  //   year       2025 | 2020年代 | 更早
  //   sort       S|U|R|T or popularity|vote_average|first_air_date
  //   exclude_genres, vote_count_gte (disables floor stepping), dedupe="1"
  async getDiscover(opts = {}) {
    const mediaType = opts.mediaType === "tv" ? "tv" : "movie";
    const page = Number(opts.page) || 1;
    const params = { page };

    if (opts.genre) {
      const ids = translateGenres(opts.genre);
      if (ids) params.with_genres = ids;
    }
    if (opts.exclude_genres) {
      const ids = translateGenres(opts.exclude_genres);
      if (ids) params.without_genres = ids;
    }
    if (opts.region && opts.region !== "全部") {
      const country = REGION_TO_COUNTRY[opts.region];
      if (country) params.with_origin_country = country;
    }
    const lang = opts.language || (opts.region ? REGION_TO_LANGUAGE[opts.region] : "");
    if (lang) params.with_original_language = lang;

    const y = opts.year;
    if (y && y !== "all") {
      const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
      if (/^\d{4}$/.test(y)) {
        params[mediaType === "movie" ? "primary_release_year" : "first_air_date_year"] = y;
      } else if (/年代$/.test(y)) {
        const decade = parseInt(y, 10);
        params[`${dateField}.gte`] = `${decade}-01-01`;
        params[`${dateField}.lte`] = `${decade + 9}-12-31`;
      } else if (y === "更早") {
        params[`${dateField}.lte`] = "1980-01-01";
      }
    }

    let sortBy = SORT_MAP[opts.sort || "S"] || "popularity.desc";
    if (mediaType === "tv" && sortBy === "primary_release_date.desc") sortBy = "first_air_date.desc";
    params.sort_by = sortBy;

    // Rating sorts rank 1-2 vote 10.0s first without a floor; popularity is
    // a page-traffic score, not quality (a 21-vote B-movie outranked a
    // 9k-vote classic). Only date sorts are safe without one.
    const endpoint = mediaType === "tv" ? "/discover/tv" : "/discover/movie";
    const needsFloor = sortBy === "vote_average.desc" || sortBy === "popularity.desc";
    let data;
    if (needsFloor) {
      const explicit = Number(opts.vote_count_gte) || 0;
      const steps = explicit ? [explicit] : VOTE_FLOOR_STEPS;
      for (const floor of steps) {
        data = await this._getWithFallback(endpoint, { ...params, "vote_count.gte": floor });
        if ((data?.total_results || 0) >= PAGE_TARGET) break;
      }
    } else {
      data = await this._getWithFallback(endpoint, params);
    }

    const normalized = await this._normalizeList(data, mediaType);
    if (opts.dedupe === "1") normalized.list = dedupeSeries(normalized.list);
    return normalized;
  }

}

export const tmdb = new TmdbClient();
