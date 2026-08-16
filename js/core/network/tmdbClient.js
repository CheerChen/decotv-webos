// tmdbClient.js — TMDB catalog sidecar client for webOS.
// Talks to the decotv-tmdb-sidecar service (port 4001) which proxies
// TMDB trending/discover/chart endpoints and images. No auth cookie —
// the sidecar is LAN-only and open. On webOS, requests go through the
// bundled Luna JS service (fetchSidecar / fetchSidecarImage methods)
// so the file:// page does not need direct network access.

import { LocalStore } from "../storage/localStore.js";
import {
  hasLunaTransport,
  lunaSidecarFetch,
  lunaSidecarFetchImage
} from "./lunaTransport.js";

const STORAGE_SIDECAR_URL = "decotv.tmdbSidecarUrl";
// Sidecar sits next to the DecoTV server: same host, port 4001. When no
// explicit URL is stored (the common case), it is derived from the
// configured DecoTV server address — the user never types it.
const SIDECAR_PORT = 4001;

export class TmdbClient {
  constructor() {
    this.sidecarUrl = "";
    this.serverBaseUrl = "";
  }

  // The DecoTV server this client is connected to; the sidecar is derived
  // from it (same host, port 4001). Set during auth bootstrap alongside
  // api.setBaseUrl.
  setServerBaseUrl(url) {
    this.serverBaseUrl = String(url || "").trim();
  }

  // Derive the sidecar URL from the DecoTV server base URL (same host,
  // fixed port 4001). Returns "" when no server is configured.
  deriveSidecarUrl(serverBaseUrl) {
    const base = String(serverBaseUrl || "").trim() || this.serverBaseUrl;
    if (!base) return "";
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.hostname}:${SIDECAR_PORT}`;
    } catch (_) {
      return "";
    }
  }

  setSidecarUrl(url) {
    // Normalize: strip trailing slash, keep origin only.
    this.sidecarUrl = (url || "").replace(/\/+$/, "");
    if (url) LocalStore.set(STORAGE_SIDECAR_URL, this.sidecarUrl);
    else LocalStore.remove(STORAGE_SIDECAR_URL);
  }

  getStoredSidecarUrl() {
    return LocalStore.get(STORAGE_SIDECAR_URL, null);
  }

  isConfigured(serverBaseUrl) {
    return Boolean(
      this.sidecarUrl ||
      this.getStoredSidecarUrl() ||
      this.deriveSidecarUrl(serverBaseUrl)
    );
  }

  // Resolve the sidecar URL to use: explicit stored value wins, otherwise
  // derived from the DecoTV server address.
  resolveSidecarUrl(serverBaseUrl) {
    return this.sidecarUrl || this.getStoredSidecarUrl() || this.deriveSidecarUrl(serverBaseUrl) || "";
  }

  _ensureUrl() {
    if (this.sidecarUrl) return this.sidecarUrl;
    const stored = this.getStoredSidecarUrl();
    if (stored) {
      this.sidecarUrl = stored;
      return this.sidecarUrl;
    }
    // Not stored — derive from the DecoTV server the app is connected to
    // (same host, port 4001).
    const derived = this.deriveSidecarUrl();
    if (!derived) throw new Error("SIDECAR_URL_NOT_SET");
    this.sidecarUrl = derived;
    return this.sidecarUrl;
  }

  async _fetch(path, options = {}) {
    const baseUrl = this._ensureUrl();
    const timeoutMs = options.timeoutMs ?? 10000;
    if (hasLunaTransport()) {
      const response = await lunaSidecarFetch(baseUrl, path, {
        ...options,
        timeoutMs
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }
    // Browser/dev preview: direct fetch, no cookie needed.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        ...options
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (e) {
      if (e?.name === "AbortError") throw new Error("TIMEOUT");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Catalog ──────────────────────────────────────────────────────────────

  // Chart: hot / latest / top_rated / hidden_gems
  async getChart(mediaType, chart, page = 1) {
    const params = new URLSearchParams({
      action: "chart",
      mediaType,
      chart,
      page: String(page),
    });
    const data = await this._fetch(`/api/catalog?${params}`);
    return data;
  }

  // Discover with semantic filters (Douban-compatible labels)
  async getDiscover(opts = {}) {
    const params = new URLSearchParams({ action: "discover" });
    if (opts.mediaType) params.set("mediaType", opts.mediaType);
    if (opts.genre) params.set("genre", opts.genre);
    if (opts.region) params.set("region", opts.region);
    // Explicit original-language filter (e.g. anime tab defaults to ja).
    if (opts.language) params.set("language", opts.language);
    // Curated tabs dedupe franchise repeats on the sidecar.
    if (opts.dedupe) params.set("dedupe", opts.dedupe);
    if (opts.year) params.set("year", opts.year);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.exclude_genres) params.set("exclude_genres", opts.exclude_genres);
    if (opts.vote_count_gte) params.set("vote_count_gte", String(opts.vote_count_gte));
    if (opts.page) params.set("page", String(opts.page));
    const data = await this._fetch(`/api/catalog?${params}`);
    return data;
  }

  // Trending: cross-media (all/movie/tv), day/week window
  async getTrending(mediaType = "all", window = "week", page = 1) {
    const params = new URLSearchParams({
      action: "trending",
      mediaType,
      window,
      page: String(page),
    });
    const data = await this._fetch(`/api/catalog?${params}`);
    return data;
  }

  // ── Image URL builder ────────────────────────────────────────────────────
  // Wraps a TMDB image path into a sidecar /api/image URL. The sidecar
  // proxies the bytes from image.tmdb.org (public, no key). On webOS the
  // actual fetch goes through lunaSidecarFetchImage; this builder just
  // produces the logical URL that posterImage.js will resolve.
  getImageUrl(tmdbImagePath) {
    if (!tmdbImagePath) return "";
    const baseUrl = this.resolveSidecarUrl();
    if (!baseUrl) return "";
    // tmdbImagePath is either a full URL or a /xxxx.jpg path.
    const fullUrl = tmdbImagePath.startsWith("http")
      ? tmdbImagePath
      : `https://image.tmdb.org/t/p/w500${tmdbImagePath}`;
    return `${baseUrl}/api/image?url=${encodeURIComponent(fullUrl)}`;
  }
}

export const tmdb = new TmdbClient();
export { STORAGE_SIDECAR_URL };
