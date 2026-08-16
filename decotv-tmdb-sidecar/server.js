// decotv-tmdb-sidecar — standalone TMDB catalog proxy for DecoTV webOS.
// Exposes a semantic catalog API that maps to TMDB discover/trending/chart
// endpoints, plus a pass-through image proxy (TMDB images are public, no key
// needed). No auth — LAN only. The TMDB API key lives in this process only.
//
// Endpoints:
//   GET /api/catalog?action=...&mediaType=...&...
//   GET /api/image?url=...
//   GET /healthz

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4001);
const TMDB_API_KEY = (process.env.TMDB_API_KEY || "").trim();
const TMDB_BASE = (process.env.TMDB_BASE || "https://api.themoviedb.org/3").replace(/\/+$/, "");
const TMDB_IMAGE_BASE = (process.env.TMDB_IMAGE_BASE || "https://image.tmdb.org/t/p").replace(/\/+$/, "");
const TMDB_PROXY = (process.env.TMDB_PROXY || "").trim();
// Optional reverse proxy base (replaces TMDB_BASE when set).
const TMDB_REVERSE_PROXY = (process.env.TMDB_REVERSE_PROXY || "").trim();
const TMDB_TIMEOUT_MS = Number(process.env.TMDB_TIMEOUT_MS || 10000);
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 86400);

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
  "真人秀": 10764, "肥皂剧": 10766, "脱口秀": 10767,
  // Sci-Fi & Fantasy (tv) — TMDB returns English name for this one in zh-CN
  "Sci-Fi & Fantasy": 10765, "War & Politics": 10768,
  // documentary
  "纪录": 99, "纪录片": 99,
  // show sub-genres (map to tv genres)
  "真人秀": 10764, "脱口秀": 10767, "谈话": 10767,
};

// Chinese region labels (matching Douban) → ISO 3166-1 codes for
// with_origin_country, and ISO 639-1 codes for with_original_language.
// Douban's "地区" is ambiguous (production country vs language); we map
// region → country code for discover, and expose language as a separate
// filter the client can send.
const REGION_TO_COUNTRY = {
  "全部": "", "华语": "CN|HK|TW", "欧美": "US", "美国": "US", "日本": "JP",
  "韩国": "KR", "中国香港": "HK", "中国台湾": "TW",
  "法国": "FR", "英国": "GB", "印度": "IN",
};
// When Douban region is a language concept, map to original_language.
// zh = Mandarin (mainland/Taiwan), cn = Cantonese (HK) — 华语 needs both,
// and 中国香港 is cn (少林足球/功夫/蜜桃成熟时 are all cn).
// 欧美 kept for anime/doc sub-lists (欧美动画/欧美纪录片) even though the
// main REGIONS_FULL no longer offers it.
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

// Chart names → TMDB endpoints.
// Douban charts: 热门/最新/豆瓣高分/冷门佳片
const CHART_ENDPOINTS = {
  movie: {
    hot: "/trending/movie/week",
    latest: "/movie/now_playing",
    // top_rated endpoint has NO vote-count floor (1-vote 10.0s rank first),
    // so it goes through discover with an explicit vote_count.gte.
    top_rated: "/discover/movie",
    hidden_gems: "/discover/movie",
  },
  tv: {
    hot: "/trending/tv/week",
    latest: "/tv/airing_today",
    top_rated: "/discover/tv",
    hidden_gems: "/discover/tv",
  },
};

// ── In-memory TTL cache ───────────────────────────────────────────────────
const cache = new Map();
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCached(key, data, ttlSeconds) {
  cache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ── HTTP fetch with timeout ───────────────────────────────────────────────
function fetchWithTimeout(url, { headers = {}, timeoutMs = TMDB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal, headers })
      .then(async (res) => {
        const text = await res.text();
        return { status: res.status, headers: res.headers, body: text };
      })
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function buildTmdbUrl(endpoint, params = {}) {
  const base = TMDB_REVERSE_PROXY
    ? `${TMDB_REVERSE_PROXY.replace(/\/+$/, "")}/3`
    : TMDB_BASE;
  const query = new URLSearchParams();
  query.set("api_key", TMDB_API_KEY);
  query.set("language", "zh-CN");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
  }
  return `${base}${endpoint}?${query.toString()}`;
}

function buildForwardProxyUrl(proxy, targetUrl) {
  if (proxy.includes("{url}")) return proxy.replace("{url}", encodeURIComponent(targetUrl));
  return `${proxy.replace(/\/+$/, "")}?url=${encodeURIComponent(targetUrl)}`;
}

async function tmdbFetch(endpoint, params = {}, ttlSeconds = CACHE_TTL_SECONDS) {
  if (!TMDB_API_KEY) {
    throw { status: 400, error: "TMDB_API_KEY not configured" };
  }
  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const targetUrl = buildTmdbUrl(endpoint, params);
  const requestUrl = TMDB_PROXY
    ? buildForwardProxyUrl(TMDB_PROXY, targetUrl)
    : targetUrl;

  try {
    const { status, body } = await fetchWithTimeout(requestUrl, {
      headers: TMDB_PROXY ? { "X-TMDB-Target": targetUrl, Accept: "application/json" } : { Accept: "application/json" },
    });
    if (status !== 200) {
      throw { status: 502, error: `TMDB upstream returned ${status}`, body: body.slice(0, 200) };
    }
    const data = JSON.parse(body);
    setCached(cacheKey, data, ttlSeconds);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw { status: 504, error: "TMDB request timed out" };
    throw e;
  }
}

// ── Language fallback: zh-CN → en-US when zh result is sparse ──────────────
async function tmdbFetchWithFallback(endpoint, params = {}, ttlSeconds = CACHE_TTL_SECONDS) {
  try {
    const zh = await tmdbFetch(endpoint, params, ttlSeconds);
    if (hasMeaningfulResults(zh)) return zh;
    // zh-CN returned sparse data (missing titles/overviews) — try en-US.
    const enParams = { ...params, language: "en-US" };
    const en = await tmdbFetch(endpoint, enParams, ttlSeconds);
    return mergeLanguageFallback(zh, en);
  } catch (e) {
    // If zh failed entirely, try en as last resort.
    if (e.status === 502 || e.status === 504) {
      const enParams = { ...params, language: "en-US" };
      return tmdbFetch(endpoint, enParams, ttlSeconds);
    }
    throw e;
  }
}

function hasMeaningfulResults(data) {
  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) return true; // empty is meaningful
  // Sparse = first 3 items all missing title/name
  const first3 = results.slice(0, 3);
  return first3.some((x) => (x.title || x.name || "").trim());
}

function mergeLanguageFallback(zh, en) {
  if (!en?.results) return zh;
  const enById = new Map(en.results.map((x) => [x.id, x]));
  zh.results = zh.results.map((x) => {
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
  });
  return zh;
}

// ── Normalization: TMDB item → Douban-compatible shape ────────────────────
// Poster localization: TMDB serves per-language poster art (the same movie has
// different posters for zh/ja/ko/en communities). We fetch /images once per
// item (cached in-memory) and pick the poster whose language matches the
// item's original language — so a Japanese series shows its Japanese poster,
// a Korean film its Korean one, and a Chinese film its Chinese one. Falls
// back to the list's default poster_path when no localized art exists.
const POSTER_CACHE_TTL = 7 * 86400; // 7 days: posters rarely change
const POSTER_CONCURRENCY = 6;       // images API is rate-limited; don't fan out 20/page

function posterLangOf(lang) {
  // Map TMDB original_language (2-letter) to the language code used by
  // /images (same 2-letter codes); anything exotic falls back to en.
  const known = ["zh", "ja", "ko", "en", "fr", "de", "es", "it", "ru", "th", "hi", "pt", "nl"];
  return known.includes(lang) ? lang : "en";
}

async function localizedPosterPath(mediaType, id, originalLanguage) {
  const cacheKey = `poster:${mediaType}:${id}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const data = await tmdbFetch(
      `/${mediaType}/${id}/images`,
      { include_image_language: "zh,ja,ko,en,null", language: "en-US" },
      POSTER_CACHE_TTL
    );
    const posters = data?.posters || [];
    const lang = posterLangOf(originalLanguage);
    // Prefer the item's original language, highest-voted poster in it.
    // (TMDB lists several posters per language; vote_average marks the
    // community-preferred one — first-match picks a low-vote duplicate.)
    const byLang = posters.filter((p) => p.iso_639_1 === lang && p.file_path);
    const any = posters.filter((p) => p.iso_639_1 && p.file_path);
    const pool = byLang.length ? byLang : any;
    const pick = pool.length
      ? pool.reduce((best, p) => (Number(p.vote_average) > Number(best.vote_average) ? p : best))
      : posters[0];
    const path = pick?.file_path || "";
    setCached(cacheKey, path, POSTER_CACHE_TTL);
    return path;
  } catch (_) {
    return "";
  }
}

async function normalizeItem(item, mediaType) {
  const title = item.title || item.name || "";
  const year = (item.release_date || item.first_air_date || "").slice(0, 4) || "";
  const mt = item.media_type || mediaType || (item.first_air_date ? "tv" : "movie");
  let poster = item.poster_path ? `${TMDB_IMAGE_BASE}/w500${item.poster_path}` : "";
  // Prefer the poster in the item's original language when one exists.
  const localized = await localizedPosterPath(mt, item.id, item.original_language);
  if (localized) poster = `${TMDB_IMAGE_BASE}/w500${localized}`;
  return {
    id: String(item.id),
    title,
    poster,
    rate: item.vote_average ? String(Number(item.vote_average).toFixed(1)) : "",
    year,
    _tmdb_id: item.id,
    _media_type: mt,
  };
}

// Map a list with bounded concurrency (poster localization fan-out).
async function mapConcurrent(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function normalizeList(data, mediaType) {
  const results = data?.results || [];
  const list = await mapConcurrent(results, (item) => normalizeItem(item, mediaType), POSTER_CONCURRENCY);
  return {
    code: 200,
    message: "ok",
    list,
    total: data?.total_results || list.length,
    page: data?.page || 1,
    total_pages: data?.total_pages || 1,
  };
}

// ── Series dedup for curated charts ───────────────────────────────────────
// 加百列的地狱 1/2/3 occupy three slots on the same chart. For curated lists
// (hidden_gems / 综艺 / 纪录片) collapse a franchise to its single
// highest-rated entry by comparing a normalized "base title" (subtitle after
// ：/:/— dropped, trailing 第N部/第N季/II/III/(year)/bare number/3D dropped).
function seriesBaseTitle(title) {
  let t = String(title || "").trim();
  t = t.split(/[：:]|\s-\s/)[0].trim();
  t = t.replace(/\s*第[一二三四五六七八九十百千0-9]+[部季集篇]?\s*$/, "");
  t = t.replace(/\s*[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*$/, "");
  t = t.replace(/\s*\(\d{4}\)\s*$/, "");
  // Franchise number suffix (蠢蛋搞怪秀5 → 蠢蛋搞怪秀, 1917 → 1917).
  // Only strip when the remainder is non-empty so pure-numeric titles
  // (2046, 1917) keep their identity.
  const stripped = t.replace(/\s*\d+\s*$/, "").replace(/\s*3D\s*$/i, "");
  if (stripped.trim()) t = stripped;
  return t.trim();
}

function dedupeSeries(list) {
  const best = new Map(); // base title -> item
  const singles = [];     // items whose base title is empty/unique keep place
  for (const item of list) {
    const key = seriesBaseTitle(item.title);
    if (!key) { singles.push(item); continue; }
    const prev = best.get(key);
    if (!prev || Number(item.rate) > Number(prev.rate)) best.set(key, item);
  }
  return [...singles, ...Array.from(best.values())];
}

// ── Catalog action handlers ───────────────────────────────────────────────

// action=chart
//   mediaType=movie|tv
//   chart=hot|latest|top_rated|hidden_gems
//   page=1
async function handleChart(params) {
  const mediaType = params.mediaType === "tv" ? "tv" : "movie";
  const chart = params.chart || "hot";
  const page = Number(params.page) || 1;
  const endpoints = CHART_ENDPOINTS[mediaType];
  const endpoint = endpoints[chart];
  if (!endpoint) throw { status: 400, error: `Unknown chart: ${chart}` };

  if (chart === "hidden_gems") {
    // Douban 冷门佳片 is "highly rated but underexposed" — NOT low-vote
    // obscurities. Verified against the DecoTV source site: a 20-500 vote
    // window surfaced 20-vote concert films, docs and English-only shorts
    // that no Chinese resource site carries. The working window keeps a
    // real audience (500-5000 votes), drops concerts/docs (10402,99), and
    // excludes this year's releases (their scores are inflated and no
    // source site has them yet). Language window mirrors what the Chinese
    // source sites cover.
    const discoverParams = {
      sort_by: "vote_average.desc",
      "vote_average.gte": 7.5,
      "vote_count.gte": 500,
      "vote_count.lte": 5000,
      without_genres: "10402,99",
      with_original_language: "zh|ja|ko|en|fr|de|es",
      page,
    };
    if (mediaType === "tv") {
      discoverParams["first_air_date.lte"] = "2024-12-31";
    } else {
      discoverParams["primary_release_date.lte"] = "2024-12-31";
    }
    const data = await tmdbFetchWithFallback(endpoint, discoverParams);
    const normalized = await normalizeList(data, mediaType);
    normalized.list = dedupeSeries(normalized.list);
    return normalized;
  }

  if (chart === "top_rated") {
    // 豆瓣高分榜: same ordering as vote_average.desc but with a real
    // audience floor — without it the list is 1-2 vote 10.0 obscurities.
    const discoverParams = {
      sort_by: "vote_average.desc",
      "vote_count.gte": 500,
      page,
    };
    const data = await tmdbFetchWithFallback(endpoint, discoverParams);
    return normalizeList(data, mediaType);
  }

  const data = await tmdbFetchWithFallback(endpoint, { page });
  return normalizeList(data, mediaType);
}

// action=discover
//   mediaType=movie|tv
//   genre=剧情|喜剧|...  (Douban Chinese labels, can be comma-separated for AND, pipe for OR)
//   region=华语|美国|...  (Douban Chinese labels)
//   year=2025|2020年代|...
//   sort=S|U|R|T  (Douban sort codes)
//   language=zh|ja|ko|en|...  (optional, overrides region-derived language)
//   exclude_genres=恐怖|惊悚  (optional, comma-separated)
//   vote_count_gte=100  (optional, popularity threshold)
//   page=1
async function handleDiscover(params) {
  const mediaType = params.mediaType === "tv" ? "tv" : "movie";
  const page = Number(params.page) || 1;
  const tmdbParams = { page };

  // Genre mapping
  if (params.genre) {
    const genreIds = translateGenres(params.genre);
    if (genreIds) tmdbParams.with_genres = genreIds;
  }
  // Excluded genres (TMDB-only feature, Douban can't do this)
  if (params.exclude_genres) {
    const excludeIds = translateGenres(params.exclude_genres);
    if (excludeIds) tmdbParams.without_genres = excludeIds;
  }
  // Region → country + language
  if (params.region && params.region !== "全部") {
    const country = REGION_TO_COUNTRY[params.region];
    if (country) tmdbParams.with_origin_country = country;
  }
  // Language filter (TMDB-unique: by original language, not production country)
  const lang = params.language || (params.region ? REGION_TO_LANGUAGE[params.region] : "");
  if (lang) tmdbParams.with_original_language = lang;
  // Year
  if (params.year && params.year !== "all") {
    const y = params.year;
    if (/^\d{4}$/.test(y)) {
      if (mediaType === "movie") tmdbParams.primary_release_year = y;
      else tmdbParams.first_air_date_year = y;
    } else if (/年代$/.test(y)) {
      // "2020年代" → date range
      const decade = parseInt(y);
      const start = `${decade}-01-01`;
      const end = `${decade + 9}-12-31`;
      if (mediaType === "movie") {
        tmdbParams["primary_release_date.gte"] = start;
        tmdbParams["primary_release_date.lte"] = end;
      } else {
        tmdbParams["first_air_date.gte"] = start;
        tmdbParams["first_air_date.lte"] = end;
      }
    } else if (y === "更早") {
      if (mediaType === "movie") tmdbParams["primary_release_date.lte"] = "1980-01-01";
      else tmdbParams["first_air_date.lte"] = "1980-01-01";
    }
  }
  // Sort
  const sortCode = params.sort || "S";
  let sortBy = SORT_MAP[sortCode] || "popularity.desc";
  if (mediaType === "tv" && sortBy === "primary_release_date.desc") {
    sortBy = "first_air_date.desc";
  }
  tmdbParams.sort_by = sortBy;
  // Vote-count floor for rating sorts: vote_average.desc ranks 1-2 vote
  // 10.0 obscurities first without it — same defect the chart endpoints
  // had. Only rating sorts need the floor; popularity/date sorts are
  // already audience-weighted.
  //
  // The floor is DYNAMIC: a fixed 500 starves narrow filters (2026 + 日本 +
  // 高分优先 → 0 items, because this year's releases haven't reached 500
  // votes yet). We step the floor down until the page fills (or hit the
  // floor-5 safety net that still blocks 1-2 vote junk). Each step reuses
  // the tmdbFetch cache (keyed by params incl. vote_count.gte). An explicit
  // vote_count_gte param (client override) wins and disables the stepping.
  const VOTE_FLOOR_STEPS = [500, 200, 80, 30, 10, 5];
  const PAGE_TARGET = 20;
  const explicitVoteFloor = params.vote_count_gte
    ? Number(params.vote_count_gte)
    : 0;
  async function fetchWithVoteFloor(baseParams) {
    const steps = explicitVoteFloor ? [explicitVoteFloor] : VOTE_FLOOR_STEPS;
    for (const floor of steps) {
      const p = { ...baseParams, "vote_count.gte": floor };
      const data = await tmdbFetchWithFallback(endpoint, p);
      const count = data?.total_results || 0;
      // Enough for a full page → use this floor. Otherwise fall through to
      // the next (looser) step so narrow filters still get results.
      if (count >= PAGE_TARGET || floor === steps[steps.length - 1]) {
        return data;
      }
    }
    return null; // unreachable: last step always returns
  }

  const endpoint = mediaType === "tv" ? "/discover/tv" : "/discover/movie";
  const data = sortBy === "vote_average.desc"
    ? await fetchWithVoteFloor(tmdbParams)
    : await tmdbFetchWithFallback(endpoint, tmdbParams);
  const normalized = await normalizeList(data, mediaType);
  // Curated tabs (综艺/纪录片) dedupe franchises the same way hidden_gems
  // does — Paradise Hotel x3 / 蠢蛋搞怪秀 x4 occupying one chart looks broken.
  if (params.dedupe === "1") {
    normalized.list = dedupeSeries(normalized.list);
  }
  return normalized;
}

// action=trending
//   mediaType=all|movie|tv  (default: all — cross-media, Douban can't do this)
//   window=day|week  (default: week)
//   page=1
async function handleTrending(params) {
  const mediaType = params.mediaType || "all";
  const window = params.window === "day" ? "day" : "week";
  const page = Number(params.page) || 1;
  const endpoint = `/trending/${mediaType}/${window}`;
  const data = await tmdbFetchWithFallback(endpoint, { page });
  return normalizeList(data, mediaType);
}

// action=genres
//   mediaType=movie|tv
// Returns the TMDB genre list in Chinese (for client to build filter UI).
async function handleGenres(params) {
  const mediaType = params.mediaType === "tv" ? "tv" : "movie";
  const data = await tmdbFetchWithFallback(`/genre/${mediaType}/list`, {}, 604800); // cache 7 days
  return data;
}

// ── Genre label → id translation ──────────────────────────────────────────
function translateGenres(labelStr) {
  // labelStr can be comma-separated (AND) or pipe-separated (OR)
  // e.g. "动作,喜剧" → "28,35" (AND), "动作|喜剧" → "28|35" (OR)
  // Also accepts raw numeric TMDB genre ids ("16", "10764,99") —
  // browseConfig's genrePreset sends those directly.
  const labels = labelStr.split(/[,|]/);
  if (labels.every((l) => /^\d+$/.test(l.trim()))) {
    return labelStr; // already TMDB ids, pass through unchanged
  }
  const sep = labelStr.includes("|") && !labelStr.includes(",") ? "|" : ",";
  const ids = labels.map((l) => GENRE_MAP[l.trim()]).filter(Boolean);
  if (ids.length === 0) return "";
  // Preserve the separator semantics
  if (labelStr.includes("|") && !labelStr.includes(",")) {
    return ids.join("|");
  }
  return ids.join(",");
}

// ── Image proxy (TMDB images are public, no key needed) ───────────────────
// Uses a dedicated binary fetch — fetchWithTimeout reads responses as text
// (res.text()), which UTF-8-mangles binary image bytes into replacement
// characters. Images must be fetched as ArrayBuffer and re-emitted as-is.
async function handleImage(req, res, parsedUrl) {
  const targetUrl = parsedUrl.searchParams.get("url");
  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "url parameter required" }));
    return;
  }
  // Only allow TMDB image host to prevent open-proxy abuse.
  const allowed = ["image.tmdb.org"];
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid url" }));
    return;
  }
  if (!allowed.some((h) => target.hostname === h || target.hostname.endsWith("." + h))) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "only TMDB images allowed" }));
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timer);
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, immutable",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "image fetch failed" }));
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // CORS for all responses (LAN, no auth)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tmdb: Boolean(TMDB_API_KEY) }));
    return;
  }

  if (pathname === "/api/image") {
    return handleImage(req, res, parsedUrl);
  }

  if (pathname === "/api/catalog") {
    if (!TMDB_API_KEY) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "TMDB_API_KEY not configured" }));
      return;
    }
    const p = parsedUrl.searchParams;
    const action = (p.get("action") || "").trim();
    const params = Object.fromEntries(p.entries());
    try {
      let result;
      switch (action) {
        case "chart": result = await handleChart(params); break;
        case "discover": result = await handleDiscover(params); break;
        case "trending": result = await handleTrending(params); break;
        case "genres": result = await handleGenres(params); break;
        default:
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `unknown action: ${action || "(empty)"}` }));
          return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
      res.end(JSON.stringify(result));
    } catch (e) {
      const status = e.status || 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.error || "internal error" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`decotv-tmdb-sidecar listening on :${PORT} (tmdb: ${TMDB_API_KEY ? "enabled" : "disabled"})`);
});
