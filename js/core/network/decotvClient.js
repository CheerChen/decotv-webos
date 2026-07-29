// decotvClient.js — DecoTV / LunaTV-compatible API client for webOS.
// Ported from OrionTV services/api.ts (TypeScript → vanilla JS).
// AsyncStorage → localStorage. On webOS, authenticated requests go through the
// bundled Luna JS service so its Node process can persist the auth cookie.
// Browser/dev preview falls back to fetch().

import { LocalStore } from "../storage/localStore.js";
import {
  clearLunaSession,
  getLunaSession,
  hasLunaTransport,
  lunaFetch
} from "./lunaTransport.js";

// region: --- Types (documentation only, JS) ---
// DoubanItem       { id, title, poster, rate, year }
// DoubanResponse   { code, message, list: DoubanItem[] }
// SearchResult     { id, title, poster, episodes: string[], source, source_name, year, type_name, desc }
// VideoDetail      { id, title, poster, source, source_name, episodes: string[], desc, year, director, actor, remarks }
// Favorite         { cover, title, source_name, total_episodes, search_title, year, save_time }
// PlayRecord       { title, source_name, cover, index, total_episodes, play_time, total_time, save_time, year }
// ApiSite          { key, name, api, detail, is_adult, from, disabled }
// ServerConfig     { SiteName, StorageType, AuthMode, Version, ... }

const STORAGE_BASEURL = "decotv.apiBaseUrl";
const STORAGE_SERVERCONFIG = "decotv.serverConfig";

export class DecoTVClient {
  constructor(baseURL) {
    this.baseURL = baseURL || "";
    this.onUnauthorized = null;
  }

  setBaseUrl(url) {
    this.baseURL = url;
    if (url) LocalStore.set(STORAGE_BASEURL, url);
    else LocalStore.remove(STORAGE_BASEURL);
  }

  getStoredBaseUrl() {
    return LocalStore.get(STORAGE_BASEURL, null);
  }

  getStoredServerConfig() {
    return LocalStore.get(STORAGE_SERVERCONFIG, null);
  }

  setStoredServerConfig(cfg) {
    if (cfg) LocalStore.set(STORAGE_SERVERCONFIG, cfg);
    else LocalStore.remove(STORAGE_SERVERCONFIG);
  }

  setUnauthorizedHandler(fn) {
    this.onUnauthorized = fn;
  }

  async _fetch(url, options = {}) {
    if (!this.baseURL) throw new Error("API_URL_NOT_SET");
    const timeoutMs = options.timeoutMs ?? 10000;
    const requestOptions = { ...options };
    delete requestOptions.timeoutMs;

    if (hasLunaTransport()) {
      const response = await lunaFetch(this.baseURL, url, {
        ...requestOptions,
        timeoutMs
      });
      return this._checkResponse(response);
    }

    // Default timeout: 10s. Caller can override via options.timeoutMs = 0 (no timeout)
    // or pass their own AbortController via options.signal (timeout is skipped).
    const callerSignal = requestOptions.signal;
    if (timeoutMs > 0 && !callerSignal) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseURL}${url}`, {
          credentials: "include",
          ...requestOptions,
          signal: controller.signal,
        });
        return this._checkResponse(response);
      } catch (e) {
        if (e?.name === "AbortError") throw new Error("TIMEOUT");
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    // No timeout or caller has own signal — pass through directly.
    const response = await fetch(`${this.baseURL}${url}`, {
      credentials: "include",
      ...requestOptions,
    });
    return this._checkResponse(response);
  }

  _checkResponse(response) {
    if (response.status === 401) {
      // Global 401 hook — authManager will navigate to login/server screen.
      if (typeof this.onUnauthorized === "function") {
        try { this.onUnauthorized(); } catch (_) {}
      }
      throw new Error("UNAUTHORIZED");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  async login(username, password) {
    const response = await this._fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username ?? undefined, password: password ?? undefined })
    });
    return response.json();
  }

  async logout() {
    try {
      await this._fetch("/api/logout", { method: "POST" });
    } catch (e) {
      // best-effort: network errors don't block local cleanup
    } finally {
      await clearLunaSession(this.baseURL);
    }
    return { ok: true };
  }

  async hasPersistedSession() {
    const state = await getLunaSession(this.baseURL);
    return state.hasSession;
  }

  async getServerConfig() {
    const response = await this._fetch("/api/server-config");
    return response.json();
  }

  // ── Catalog (Douban) ────────────────────────────────────────────────────
  // Verified shape: { code:200, message, list:[{id,title,poster,rate,year}] }

  async getDoubanData(type, tag, pageSize = 24, pageStart = 0) {
    const url = `/api/douban?type=${encodeURIComponent(type)}&tag=${encodeURIComponent(tag)}&pageSize=${pageSize}&pageStart=${pageStart}`;
    const response = await this._fetch(url);
    return response.json();
  }

  // Douban sub-category API (tv/show with region/type filters).
  // kind: "tv" | "movie", category: e.g. "最近热门", type: e.g. "tv", "tv_domestic", "show"
  async getDoubanCategories(kind, category, type, limit = 24, start = 0) {
    const params = new URLSearchParams({
      kind, category, type,
      limit: String(limit),
      start: String(start),
      proxyType: "auto",
    });
    const response = await this._fetch(`/api/douban/categories?${params}`);
    return response.json();
  }

  // Douban recommends API (anime 番剧/剧场版, movie/tv "全部" with multi-level filters).
  async getDoubanRecommends(kind, opts = {}) {
    const params = new URLSearchParams({
      kind,
      limit: String(opts.limit || 24),
      start: String(opts.start || 0),
      category: opts.category || "",
      format: opts.format || "",
      label: opts.label || "",
      region: opts.region || "",
      year: opts.year || "",
      platform: opts.platform || "",
      sort: opts.sort || "",
      proxyType: "auto",
    });
    const response = await this._fetch(`/api/douban/recommends?${params}`);
    return response.json();
  }

  // Bangumi calendar API (anime "每日放送" — per-weekday anime list).
  // Returns array of { weekday: {en}, items: [...] }.
  async getBangumiCalendar() {
    const response = await fetch("https://api.bgm.tv/calendar");
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  // ── Search ──────────────────────────────────────────────────────────────
  // Verified shape: { results: SearchResult[] }, episodes is array of playable URLs.

  async searchVideos(query) {
    const url = `/api/search?q=${encodeURIComponent(query)}`;
    const response = await this._fetch(url);
    return response.json();
  }

  async searchOne(query, resourceId, signal) {
    const url = `/api/search/one?q=${encodeURIComponent(query)}&resourceId=${encodeURIComponent(resourceId)}`;
    const response = await this._fetch(url, { signal });
    return response.json();
  }

  async getResources(signal) {
    const response = await this._fetch("/api/search/resources", { signal });
    return response.json();
  }

  // ── Detail ──────────────────────────────────────────────────────────────
  // Verified: detail also returns episodes[] (OrionTV interface omitted this).

  async getVideoDetail(source, id) {
    const url = `/api/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
    const response = await this._fetch(url);
    return response.json();
  }

  // ── Playback resolve (fallback; search/detail usually return playable URLs already) ─

  async resolvePlayback(url, source) {
    const u = `/api/playback/resolve?url=${encodeURIComponent(url)}&source=${encodeURIComponent(source)}`;
    const response = await this._fetch(u);
    return response.json();
  }

  // ── Playback probe (source speed/quality test) ──────────────────────────
  // Mirrors DecoTV web client probePlaybackSourceOnServer. Returns:
  //   { quality, loadSpeed, pingTime, speedKBps, startupTimeMs, hasError,
  //     status, playable, message, failureKind, mediaType,
  //     originalUrl, resolvedUrl, playbackUrl, resolved, proxied, testedAt }
  async probePlayback(url, source, timeoutMs = 8000, signal) {
    const u = `/api/playback/probe?url=${encodeURIComponent(url)}&source=${encodeURIComponent(source)}&timeoutMs=${timeoutMs}`;
    const response = await this._fetch(u, { signal });
    return response.json();
  }

  // ── Favorites ───────────────────────────────────────────────────────────

  async getFavorites(key) {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url);
    return response.json();
  }

  async addFavorite(key, favorite) {
    const response = await this._fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, favorite })
    });
    return response.json();
  }

  async deleteFavorite(key) {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  // ── Play records ────────────────────────────────────────────────────────

  async getPlayRecords() {
    const response = await this._fetch("/api/playrecords");
    return response.json();
  }

  async savePlayRecord(key, record) {
    const response = await this._fetch("/api/playrecords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, record })
    });
    return response.json();
  }

  async deletePlayRecord(key) {
    const url = key ? `/api/playrecords?key=${encodeURIComponent(key)}` : "/api/playrecords";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  // ── Search history ──────────────────────────────────────────────────────

  async getSearchHistory() {
    const response = await this._fetch("/api/searchhistory");
    return response.json();
  }

  async addSearchHistory(keyword) {
    const response = await this._fetch("/api/searchhistory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword })
    });
    return response.json();
  }

  async deleteSearchHistory(keyword) {
    const url = keyword ? `/api/searchhistory?keyword=${encodeURIComponent(keyword)}` : "/api/searchhistory";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  // ── Image proxy URL builder (no fetch — used in <img src>) ───────────────

  getImageProxyUrl(imageUrl) {
    if (!this.baseURL || !imageUrl) return imageUrl;
    if (imageUrl.startsWith(this.baseURL) || imageUrl.startsWith("/api/")) {
      return imageUrl.startsWith("http") ? imageUrl : `${this.baseURL}${imageUrl}`;
    }
    return `${this.baseURL}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  }
}

export const api = new DecoTVClient();
export { STORAGE_BASEURL };
