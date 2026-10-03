// doubanDirect.js — direct Douban catalog access (rexxar) for webOS.
//
// The DecoTV server's /api/douban* routes proxy Douban but strip everything
// except id/title/poster/rate/year. That data loss is why the "高分优先"
// (sort=S) grid drowns in concert films: the rating-count signal that
// separates a 3k-vote fan concert from a 3M-vote classic never reaches the
// client. This module is now the ONLY Douban catalog path: all three server
// routes are replaced by rexxar endpoints on m.douban.com, fetched through
// the Luna service (which injects the Referer the webview cannot send):
//
//   /api/douban?type&tag        → /rexxar/api/v2/subject_collection/{id}/items
//   /api/douban/categories      → /rexxar/api/v2/subject/recent_hot/{kind}
//   /api/douban/recommends      → /rexxar/api/v2/{kind}/recommend
//
// There is no server fallback — a direct failure surfaces as an error so
// the UI shows 加载失败 rather than a silent empty grid.
//
// No content-based special-casing: the vote floor is the only filter. A
// concert film is filtered because its audience is small, not because it is
// a concert film.

import { hasLunaTransport, lunaDoubanFetch } from "./lunaTransport.js";
import { makeWork } from "../catalog/work.js";

// How many items to pull from rexxar per upstream batch. Larger batches mean
// fewer requests for the same filtered output; 3 external pages per request
// keeps the JSON well under the service's 2 MiB cap.
const UPSTREAM_BATCH = 60;

// Vote-count floor steps for sort=S, strictest first. Douban's rating
// population is far larger than TMDB's, so the floor stays high: 10k already
// removes the fan-concert band (observed 0.5k-11k votes) while keeping any
// broadly-seen film. The steps only loosen when a query is so narrow that
// the strict floor starves it — a full page must still be servable.
const VOTE_FLOOR_STEPS = [10000, 3000, 1000];

// Consecutive upstream batches with (almost) no survivors before the floor
// steps down one notch.
const HUNGRY_STEP_THRESHOLD = 2;

// Safety valve: rexxar's pagination cursor is non-strict (mid-pool batches
// can come back short — 59/60, 16/60 observed — and items repeat), so the
// only reliable end signal is an EMPTY batch. A pathological upstream that
// keeps returning only already-seen items would otherwise spin; cap the
// upstream fetches per external page well above any sane fill need.
const MAX_FETCHES_PER_PAGE = 25;

// Circuit breaker: after this many consecutive direct failures, stop trying
// direct for the cooldown window — requests fail fast instead of paying a
// 12s timeout per catalog row.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

// One paginator per query; caps memory if the user hops between many
// category combinations (each holds a small buffer + a Set of seen ids).
const MAX_PAGINATORS = 12;

const state = {
  paginators: new Map(), // queryKey -> RecommendPaginator
  breakerFailures: 0,
  breakerOpenUntil: 0
};

// ── rexxar URL building (mirrors the DecoTV server's recommends route) ────

function normParam(value) {
  const s = String(value || "").trim();
  return (!s || s === "all" || s === "T") ? "" : s;
}

export function buildRecommendPath(kind, opts, start, count) {
  const category = normParam(opts.category);
  const format = normParam(opts.format);
  const region = normParam(opts.region);
  const year = normParam(opts.year);
  const platform = normParam(opts.platform);
  const label = normParam(opts.label);
  const sort = normParam(opts.sort);

  const selectedCategories = { "类型": category };
  if (format) selectedCategories["形式"] = format;
  if (region) selectedCategories["地区"] = region;

  const tags = [];
  if (category) tags.push(category);
  if (!category && format) tags.push(format);
  if (label) tags.push(label);
  if (region) tags.push(region);
  if (year) tags.push(year);
  if (platform) tags.push(platform);

  const params = new URLSearchParams();
  params.append("refresh", "0");
  params.append("start", String(start));
  params.append("count", String(count));
  params.append("selected_categories", JSON.stringify(selectedCategories));
  params.append("uncollect", "false");
  params.append("score_range", "0,10");
  params.append("tags", tags.join(","));
  if (sort) params.append("sort", sort);

  return `/rexxar/api/v2/${kind}/recommend?${params.toString()}`;
}

// Map a rexxar item to the DoubanItem shape the app already renders, plus
// the two fields the server route drops: votes (rating.count) and subtitle
// (card_subtitle). Item shape differs slightly by endpoint: recommend and
// recent_hot carry `pic` + `year`, subject_collection items carry
// `cover.url` and derive year from card_subtitle instead.
export function mapRexxarItem(item) {
  const subtitle = item.card_subtitle || "";
  const kind = item.type === "movie" || item.type === "tv" ? item.type : "";
  return {
    id: String(item.id),
    work: makeWork("douban", kind, item.id),
    title: item.title,
    poster: item.pic?.normal || item.pic?.large || item.cover?.url || "",
    rate: item.rating?.value ? Number(item.rating.value).toFixed(1) : "",
    year: item.year ? String(item.year) : (subtitle.match(/(\d{4})/)?.[1] || ""),
    votes: item.rating?.count || 0,
    subtitle
  };
}

// ── paginator ─────────────────────────────────────────────────────────────

class RecommendPaginator {
  constructor(kind, opts, pageSize) {
    this.kind = kind;
    this.opts = opts;
    this.pageSize = pageSize;
    this.filterByVotes = normParam(opts.sort) === "S";
    this.floorIndex = 0;
    this.buffer = [];
    this.seen = new Set();
    this.upstreamStart = 0;
    this.exhausted = false;
    this.hungry = 0;
    this.served = 0;
  }

  currentFloor() {
    return this.filterByVotes ? VOTE_FLOOR_STEPS[Math.min(this.floorIndex, VOTE_FLOOR_STEPS.length - 1)] : 0;
  }

  async fetchUpstream() {
    const path = buildRecommendPath(this.kind, this.opts, this.upstreamStart, UPSTREAM_BATCH);
    const data = await doubanGet(path);
    if (!data || !Array.isArray(data.items)) throw new Error("DOUBAN_BAD_SHAPE");
    return data.items
      .filter((item) => item && (item.type === "movie" || item.type === "tv"))
      .map(mapRexxarItem);
  }

  async fillBuffer() {
    let fetches = 0;
    while (this.buffer.length < this.pageSize && !this.exhausted) {
      if (fetches >= MAX_FETCHES_PER_PAGE) break;
      fetches += 1;
      const batch = await this.fetchUpstream();
      // Empty batch = pool exhausted. A short batch is NOT reliable — rexxar
      // returns mid-pool short batches (59/60, 16/60) and clamps at the end.
      if (batch.length === 0) this.exhausted = true;
      this.upstreamStart += batch.length;

      const floor = this.currentFloor();
      const survivors = [];
      for (const item of batch) {
        if (this.seen.has(item.id)) continue;
        this.seen.add(item.id);
        if (!this.filterByVotes || item.votes >= floor) survivors.push(item);
      }

      // Floor stepping: batches that yield nothing pass through twice →
      // loosen one notch. Any real yield resets the hunger counter.
      if (survivors.length === 0 && batch.length > 0) {
        this.hungry += 1;
        if (this.hungry >= HUNGRY_STEP_THRESHOLD &&
            this.floorIndex < VOTE_FLOOR_STEPS.length - 1) {
          this.floorIndex += 1;
          this.hungry = 0;
        }
      } else {
        this.hungry = 0;
      }

      this.buffer = this.buffer.concat(survivors);
    }
  }

  async next() {
    await this.fillBuffer();
    const page = this.buffer.slice(0, this.pageSize);
    this.buffer = this.buffer.slice(this.pageSize);
    this.served += page.length;
    return page;
  }

  reset() {
    this.buffer = [];
    this.seen = new Set();
    this.upstreamStart = 0;
    this.exhausted = false;
    this.floorIndex = 0;
    this.hungry = 0;
    this.served = 0;
  }
}

// ── public API ────────────────────────────────────────────────────────────

function queryKey(kind, opts, pageSize) {
  const stable = ["category", "format", "region", "year", "platform", "label", "sort"]
    .map((k) => `${k}=${normParam(opts[k])}`)
    .join("&");
  return `${kind}|${stable}|${pageSize}`;
}

function directAvailable() {
  if (!hasLunaTransport()) return false;
  return Date.now() >= state.breakerOpenUntil;
}

function noteFailure() {
  state.breakerFailures += 1;
  if (state.breakerFailures >= BREAKER_THRESHOLD) {
    state.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    state.breakerFailures = 0;
  }
}

function noteSuccess() {
  state.breakerFailures = 0;
}

function getPaginator(kind, opts, pageSize, start) {
  const key = queryKey(kind, opts, pageSize);
  const paginator = state.paginators.get(key);

  if (paginator) {
    // Offset divergence (restored snapshot, aborted load): the paginator
    // cannot jump to an arbitrary filtered offset. A fresh page-0 request
    // can be served by replaying — reset and refill from upstream.
    // Anything else ends the list rather than serving a gap.
    if (paginator.served !== start) {
      if (start === 0) {
        paginator.reset();
        return paginator;
      }
      return null;
    }
    return paginator;
  }

  // Fresh join is only possible at offset 0; a fresh module with a
  // mid-stream start (app restarted onto a restored snapshot) cannot be
  // served without replaying every earlier filtered page.
  if (start > 0) return null;

  const created = new RecommendPaginator(kind, opts, pageSize);
  state.paginators.set(key, created);
  while (state.paginators.size > MAX_PAGINATORS) {
    const oldest = state.paginators.keys().next().value;
    state.paginators.delete(oldest);
  }
  return created;
}

// Low-level rexxar GET shared by all three catalog paths. The service
// injects the m.douban.com Referer and applies its own TTL cache.
async function doubanGet(path) {
  const response = await lunaDoubanFetch(path, { timeoutMs: 12000 });
  if (!response.ok) throw new Error(`DOUBAN_HTTP_${response.status}`);
  return response.json();
}

// Returns a page (array) on success, or null when direct access is
// unavailable/failed or the requested offset cannot be served — there is
// no server fallback, so the caller treats null per context (page-0 load
// fails loudly; a mid-stream gap just ends the list).
export async function getRecommendPage(kind, opts = {}, pageSize = 24) {
  if (!directAvailable()) return null;

  const paginator = getPaginator(kind, opts, pageSize, Number(opts.start || 0));
  if (!paginator) return null;

  try {
    const page = await paginator.next();
    noteSuccess();
    return page;
  } catch (e) {
    // The paginator's cursor may have advanced past buffered state; reset so
    // a retry starts over instead of serving a gap.
    paginator.reset();
    noteFailure();
    return null;
  }
}

// Recent-hot chart — replaces the server's /api/douban/categories route
// (upstream: m.douban.com/rexxar/api/v2/subject/recent_hot/{kind}). Items
// share the recommend shape, so mapRexxarItem applies directly. Unlike
// recommend there is no vote floor: recent_hot is a small curated list
// (tens of items), not an open pool. Throws on failure.
export async function getRecentHotPage(kind, category, type, start = 0, count = 24) {
  if (!directAvailable()) throw new Error("DOUBAN_UNAVAILABLE");
  const params = new URLSearchParams({
    start: String(start),
    limit: String(count),
    category: String(category || ""),
    type: String(type || ""),
  });
  try {
    const data = await doubanGet(`/rexxar/api/v2/subject/recent_hot/${kind}?${params}`);
    if (!data || !Array.isArray(data.items)) throw new Error("DOUBAN_BAD_SHAPE");
    noteSuccess();
    return data.items
      .filter((item) => item && (item.type === "movie" || item.type === "tv"))
      .map(mapRexxarItem);
  } catch (e) {
    noteFailure();
    throw e;
  }
}

// Subject-collection chart — replaces the server's /api/douban?type&tag
// route (upstream there was movie.douban.com/j/search_subjects, which
// carries no rating count and no year). The rexxar subject_collection
// endpoints are the same 热门 charts the m-site shows and do carry
// rating.count. Items live under `subject_collection_items` and use
// `cover.url` (no `pic`) — mapRexxarItem covers both. Throws on failure.
const CHART_COLLECTIONS = {
  "movie:热门": "movie_hot_gaia",
  "tv:热门": "tv_hot",
};

export async function getChartPage(type, tag, start = 0, count = 24) {
  const collection = CHART_COLLECTIONS[`${type}:${tag}`];
  if (!collection) throw new Error(`DOUBAN_NO_CHART_${type}_${tag}`);
  if (!directAvailable()) throw new Error("DOUBAN_UNAVAILABLE");
  const params = new URLSearchParams({
    start: String(start),
    count: String(count),
  });
  try {
    const data = await doubanGet(`/rexxar/api/v2/subject_collection/${collection}/items?${params}`);
    if (!data || !Array.isArray(data.subject_collection_items)) throw new Error("DOUBAN_BAD_SHAPE");
    noteSuccess();
    return data.subject_collection_items
      .filter((item) => item && (item.type === "movie" || item.type === "tv"))
      .map(mapRexxarItem);
  } catch (e) {
    noteFailure();
    throw e;
  }
}

// Subject details for the details page: /rexxar/api/v2/{movie|tv}/{id}.
// A missing subject (404) or one restricted to signed-in users (403
// need_permission) is an answer, not an outage: it returns null without
// counting toward the breaker. Anything else counts and throws.
export async function getSubject(kind, id) {
  if (kind !== "movie" && kind !== "tv") throw new Error("DOUBAN_BAD_KIND");
  if (!/^\d+$/.test(String(id || ""))) throw new Error("DOUBAN_BAD_ID");
  if (!directAvailable()) throw new Error("DOUBAN_UNAVAILABLE");
  let response;
  try {
    response = await lunaDoubanFetch(`/rexxar/api/v2/${kind}/${id}`, { timeoutMs: 12000 });
  } catch (e) {
    noteFailure();
    throw e;
  }
  if (response.status === 404) return null;
  if (response.status === 403) {
    const body = await response.text().catch(() => "");
    if (/need_permission/.test(body)) return null;
  }
  if (!response.ok) {
    noteFailure();
    throw new Error(`DOUBAN_HTTP_${response.status}`);
  }
  noteSuccess();
  return response.json();
}

// Photo wall for the landscape hero: /rexxar/api/v2/{kind}/{id}/photos.
// Same missing/restricted semantics as getSubject. Only requested when the
// user picked the landscape hero, so the default page costs nothing extra.
export async function getSubjectPhotos(kind, id, count = 30) {
  if (kind !== "movie" && kind !== "tv") throw new Error("DOUBAN_BAD_KIND");
  if (!/^\d+$/.test(String(id || ""))) throw new Error("DOUBAN_BAD_ID");
  if (!directAvailable()) throw new Error("DOUBAN_UNAVAILABLE");
  let response;
  try {
    response = await lunaDoubanFetch(`/rexxar/api/v2/${kind}/${id}/photos?count=${count}`, { timeoutMs: 12000 });
  } catch (e) {
    noteFailure();
    throw e;
  }
  if (response.status === 404) return [];
  if (response.status === 403) {
    const body = await response.text().catch(() => "");
    if (/need_permission/.test(body)) return [];
  }
  if (!response.ok) {
    noteFailure();
    throw new Error(`DOUBAN_HTTP_${response.status}`);
  }
  noteSuccess();
  const data = await response.json();
  return Array.isArray(data?.photos) ? data.photos : [];
}

// Test hook: reset all module state.
export function _resetForTest() {
  state.paginators.clear();
  state.breakerFailures = 0;
  state.breakerOpenUntil = 0;
}
