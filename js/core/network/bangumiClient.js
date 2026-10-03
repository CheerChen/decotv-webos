// bangumiClient.js — direct Bangumi (api.bgm.tv) access from the webview.
//
// api.bgm.tv answers CORS with `*` (GET and JSON POST alike), and the webOS
// webview reads cross-origin GETs without CORS anyway, so no service hop is
// needed (verified on device, 2026-10). The calendar call in decotvClient.js
// predates this module and stays where it is.

const API = "https://api.bgm.tv";
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
