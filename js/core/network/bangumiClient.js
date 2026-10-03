// bangumiClient.js — direct Bangumi (api.bgm.tv) access from the webview.
//
// api.bgm.tv answers CORS with `*` (GET and JSON POST alike), and the webOS
// webview reads cross-origin GETs without CORS anyway, so no service hop is
// needed (verified on device, 2026-10). The calendar call in decotvClient.js
// predates this module and stays where it is.

const API = "https://api.bgm.tv";
// Bangumi's own site API: the trending list lives only here (private, no
// CORS header; the webview reads it anyway — verified on device 2026-10).
const NEXT_API = "https://next.bgm.tv";
const SUBJECT_TYPE_ANIME = 2;
const DEFAULT_TIMEOUT_MS = 12000;

function bangumiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function request(url, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw bangumiError(response.status, `BANGUMI_HTTP_${response.status}`);
    return response.json();
  } catch (e) {
    if (e?.name === "AbortError") throw bangumiError(0, "BANGUMI_TIMEOUT");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// GET /v0/episodes — main-story episodes only (type 0), in list order.
export async function getBangumiEpisodes(subjectId) {
  if (!/^\d+$/.test(String(subjectId || ""))) throw bangumiError(400, "BANGUMI_BAD_ID");
  const data = await request(`${API}/v0/episodes?subject_id=${subjectId}&type=0&limit=100`);
  return Array.isArray(data?.data) ? data.data.filter((e) => e && e.type === 0) : [];
}

// GET /v0/subjects/{id}. Null when the subject does not exist.
export async function getBangumiSubject(id) {
  if (!/^\d+$/.test(String(id || ""))) throw bangumiError(400, "BANGUMI_BAD_ID");
  return request(`${API}/v0/subjects/${id}`);
}

// "12话 / 2026年10月1日 / ..." → "2026-10-01". The trending list carries the
// air date only inside this free-text line.
export function dateFromInfo(info) {
  const m = String(info || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) {
    const y = String(info || "").match(/(\d{4})年/);
    return y ? y[1] : "";
  }
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

// GET next.bgm.tv/p1/trending/subjects — what is popular now (recent
// collections and discussion). Mapped onto the v0 subject shape; NSFW and
// non-anime entries dropped.
export async function getTrendingAnime(limit = 100) {
  const data = await request(`${NEXT_API}/p1/trending/subjects?type=${SUBJECT_TYPE_ANIME}&limit=${limit}`);
  return (Array.isArray(data?.data) ? data.data : [])
    .map((entry) => entry?.subject)
    .filter((s) => s && s.id > 0 && s.type === SUBJECT_TYPE_ANIME && !s.nsfw)
    .map((s) => ({
      id: s.id,
      name: s.name || "",
      name_cn: s.nameCN || "",
      images: s.images || {},
      rating: { score: Number(s.rating?.score) || 0, total: Number(s.rating?.total) || 0 },
      tags: Array.isArray(s.metaTags) ? s.metaTags : [],
      date: dateFromInfo(s.info),
    }));
}

// POST /v0/search/subjects — anime only. `sort`: heat | score | rank | match.
// Filters use Bangumi's predicate strings (air_date ">=2026-01-01").
// The API caps a page at 20.
export async function searchAnime({ sort = "heat", tag = [], airDate = [], ratingCount = [], limit = 20, offset = 0 } = {}) {
  const filter = { type: [SUBJECT_TYPE_ANIME], nsfw: false };
  if (tag.length) filter.tag = tag;
  if (airDate.length) filter.air_date = airDate;
  if (ratingCount.length) filter.rating_count = ratingCount;
  const data = await request(`${API}/v0/search/subjects?limit=${limit}&offset=${offset}`, {
    method: "POST",
    body: { sort, filter },
  });
  return {
    total: Number(data?.total) || 0,
    data: (Array.isArray(data?.data) ? data.data : []).map((s) => ({
      ...s,
      tags: Array.isArray(s.meta_tags) ? s.meta_tags : (s.tags || []).map((t) => t?.name).filter(Boolean),
    })),
  };
}

