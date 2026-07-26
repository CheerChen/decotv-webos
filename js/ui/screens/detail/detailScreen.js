// detailScreen.js — title detail with PC-style "prefer best source" flow.
//
// Two entry modes:
//   {title, poster, year, autoPlay}  — from home/douban: search all sources,
//                                       probe each, pick best, optionally autoplay.
//   {result, query}                  — from search: single known source, play directly.
//
// Probing mirrors DecoTV src/app/play/page.tsx preferBestSource():
//   - fetch /api/search?q=title, filter by title + year + type (movie=1 ep, tv>1 ep)
//   - for each source, take episode[index].url, call /api/playback/probe
//   - rank by comparePlaybackMetrics, pick first verified (or fallback playable)
//   - show probe progress + per-source quality/speed/ping

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { showToast } from "../../../core/network/toast.js";
import {
  comparePlaybackMetrics,
  getSourceProbeKey,
  isPlayableFallbackResult,
  isVerifiedPlaybackResult
} from "../../../core/network/sourceRanking.js";

const PROBE_TIMEOUT_MS = 8000;
const PREFER_CONCURRENCY = 3;
const PREFER_MAX_WAIT_MS = 12000;
// Minimum number of verified probe results before auto-play kicks in.
// The probe keeps running in the background after this threshold is met so
// the source list fills in with real speed/latency for every source.
const PREFER_MIN_VERIFIED_FOR_AUTOPLAY = 3;

// Play-record key is per-movie (title|year), not per-source. This matches
// the 3-pick algorithm: switching sources overwrites the same record, and
// "continue watching" resumes by title regardless of which source was used.
function recordKeyFor(source) {
  return LocalLibrary.recordKeyForTitle(source.title || source.search_title, source.year);
}

// Session cache of the last prefer-mode search+probe result, so returning to a
// detail page (e.g. Back from the player) is instant and does NOT re-search or
// auto-play — it restores the sources, probe metrics and chosen source as-is.
let preferCache = null; // { key, sources, probeResults:[[k,v]], currentSourceKey }

function normalizeTitle(s) {
  return String(s || "").replaceAll(" ", "").toLowerCase();
}

function matchesYear(candidateYear, requestedYear) {
  const y = String(requestedYear || "").trim();
  const cy = String(candidateYear || "").trim();
  if (!y || !cy) return true;
  return cy.includes(y) || y.includes(cy);
}

function inferSearchType(episodes) {
  if (!Array.isArray(episodes)) return null;
  return episodes.length > 1 ? "tv" : "movie";
}

export const DetailScreen = {
  container: null,
  mode: null,           // "prefer" | "single"
  title: "",
  poster: "",
  year: "",
  autoPlay: false,
  sources: [],          // SearchResult[] after filtering
  currentSource: null,  // SearchResult
  episodeIndex: 0,
  probeResults: new Map(),  // sourceKey -> probe result
  probeRunning: false,
  probeDone: 0,
  probeTotal: 0,
  preferCancelled: false,
  detail: null,

  async mount(params = {}, opts = {}) {
    this.container = document.getElementById("detail");
    this.probeResults = new Map();
    this.probeRunning = false;
    this.probeDone = 0;
    this.probeTotal = 0;
    this.preferCancelled = false;
    this.detail = null;
    this.episodeIndex = 0;
    // On a Back navigation we must NOT auto-play again (that is what made Back
    // "reset" playback — it re-launched the player from episode 0 at 0:00).
    const fromHistory = Boolean(opts?.fromHistory);

    if (params.result) {
      this.mode = "single";
      this.currentSource = params.result;
      this.title = params.result.title;
      this.poster = params.result.poster;
      this.year = params.result.year;
      this.autoPlay = Boolean(params.autoPlay) && !fromHistory;
      this.sources = [params.result];
    } else {
      this.mode = "prefer";
      this.title = params.title || "";
      this.poster = params.poster || "";
      this.year = params.year || "";
      this.autoPlay = Boolean(params.autoPlay) && !fromHistory;
      this.currentSource = null;
      this.sources = [];
    }

    this._renderSkeleton();
    ScreenUtils.show(this.container);

    if (this.mode === "single") {
      // Already have a source; optionally fetch detail for richer metadata.
      this._maybeFetchDetail();
      if (this.autoPlay) {
        await this._startPlayback(this.currentSource, 0, { preferResume: true });
      } else {
        ScreenUtils.setInitialFocus(this.container.querySelector('.btn[data-action="play"]'));
      }
      return;
    }

    // prefer mode: search + filter + probe + pick best
    if (!this.title) {
      this._setStatus("缺少片名，无法搜索");
      return;
    }

    // Fast path: returning to a detail we already searched — restore from cache,
    // no re-search, no re-probe, no auto-play.
    const ck = `p:${this.title}|${this.year}`;
    if (fromHistory && preferCache && preferCache.key === ck && preferCache.sources.length) {
      this._restoreFromCache();
      return;
    }

    ScreenUtils.setInitialFocus(this.container.querySelector('.btn[data-action="refresh"]'));
    await this._searchAndPrefer();
    this._saveCache();
  },

  _cacheKey() {
    return this.mode === "single" && this.currentSource
      ? `s:${getSourceProbeKey(this.currentSource)}`
      : `p:${this.title}|${this.year}`;
  },

  _saveCache() {
    if (this.mode !== "prefer" || !this.sources.length) return;
    preferCache = {
      key: `p:${this.title}|${this.year}`,
      sources: this.sources,
      probeResults: Array.from(this.probeResults.entries()),
      currentSourceKey: this.currentSource ? getSourceProbeKey(this.currentSource) : ""
    };
  },

  _restoreFromCache() {
    this.sources = preferCache.sources;
    this.probeResults = new Map(preferCache.probeResults);
    this.currentSource = this.sources.find(
      (s) => getSourceProbeKey(s) === preferCache.currentSourceKey
    ) || this.sources[0];
    this._maybeFetchDetail();
    this._renderSourceList();
    this._renderEpisodes();
    this._setStatus(`已选「${this._escape(this.currentSource?.source_name || this.currentSource?.source || "")}」`);
    const playBtn = this.container.querySelector('.btn[data-action="play"]');
    if (playBtn) {
      playBtn.disabled = false;
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      playBtn.classList.add("focused");
      playBtn.focus();
    }
  },

  _renderSkeleton() {
    const poster = api.getImageProxyUrl(this.poster);
    const title = this._escape(this.title);
    this.container.innerHTML = `
      <div class="app-header">
        <div class="brand">DecoTV</div>
        <div class="nav-tabs">
          <div class="nav-tab focusable" data-action="nav-home">首页</div>
          <div class="nav-tab focusable" data-action="nav-search">搜索</div>
          <div class="nav-tab focusable" data-action="nav-library">收藏</div>
          <div class="nav-tab focusable" data-action="nav-settings">设置</div>
        </div>
      </div>
      <div class="content-scroll" id="detailScroll">
        <div class="detail-hero">
          <img class="detail-poster" src="${poster}" alt="" onerror="this.style.opacity=0.1" />
          <div class="detail-info">
            <h1 class="detail-title">${title}</h1>
            <div class="detail-tags" id="detailTags"></div>
            <div class="detail-desc" id="detailDesc"></div>
            <div class="detail-cast" id="detailCast"></div>
            <div id="detailStatus" class="detail-cast" style="color:var(--accent)">准备中…</div>
            <div style="display:flex;gap:14px;margin-top:18px;flex-wrap:wrap;" id="detailActions">
              <button class="btn primary focusable" data-action="play" disabled>播放</button>
              <button class="btn focusable" data-action="favorite">收藏</button>
              <button class="btn ghost focusable" data-action="refresh">重新测速</button>
              <button class="btn ghost focusable" data-action="back">返回</button>
            </div>
        </div>
        </div>
        <div class="section-title">播放源（测速后按质量排序）</div>
        <div id="sourceList"><div class="empty-state">正在搜索播放源…</div></div>
        <div class="section-title" id="episodesTitle" style="display:none;">剧集列表</div>
        <div class="episodes-list" id="episodesList" style="display:none;"></div>
      </div>
    `;
    this._bindNav();
  },

  _bindNav() {
    this.container.querySelectorAll('.nav-tab[data-action^="nav-"]').forEach((tab) => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        const action = tab.dataset.action;
        if (action === "nav-home") Router.navigate("home", {});
        if (action === "nav-search") Router.navigate("search", { q: this.title });
        if (action === "nav-library") Router.navigate("library", {});
        if (action === "nav-settings") Router.navigate("settings", {});
      });
    });
  },

  _setStatus(text) {
    const el = this.container?.querySelector("#detailStatus");
    if (el) el.textContent = text;
  },

  async _searchAndPrefer() {
    this._setStatus("🔍 正在搜索播放源…");
    try {
      const data = await api.searchVideos(this.title);
      const all = Array.isArray(data?.results) ? data.results : [];
      const searchType = all.length ? inferSearchType(all[0].episodes) : null;
      this.sources = all.filter((r) => {
        if (normalizeTitle(r.title) !== normalizeTitle(this.title)) return false;
        if (!matchesYear(r.year, this.year)) return false;
        if (searchType === "tv" && r.episodes.length <= 1) return false;
        if (searchType === "movie" && r.episodes.length !== 1) return false;
        return true;
      });
      if (!this.sources.length) {
        // Fallback: relax the type constraint — some sources mislabel.
        this.sources = all.filter((r) =>
          normalizeTitle(r.title) === normalizeTitle(this.title)
          && matchesYear(r.year, this.year)
        );
      }
      if (!this.sources.length) {
        this._setStatus("未找到匹配的播放源");
        this.container.querySelector("#sourceList").innerHTML = `<div class="empty-state">没有「${this._escape(this.title)}」的可用源</div>`;
        return;
      }
      this._renderSourceList();
      await this._probeAndPick();
    } catch (e) {
      this._setStatus(`搜索失败：${this._escape(e?.message || e)}`);
    }
  },

  async _probeAndPick() {
    if (!this.sources.length) return;
    this.probeRunning = true;
    this.probeDone = 0;
    this.probeTotal = this.sources.length;
    this.probeResults = new Map();
    this._setStatus(`⚡ 正在优选最佳播放源…（0/${this.probeTotal}）`);

    // No short-circuit abort: every source is probed so the source list shows
    // real speed/latency for all of them. autoPlay fires once after at least
    // PREFER_MIN_VERIFIED_FOR_AUTOPLAY verified results are in (or when all
    // probes finish if fewer than that verify). The deadline still caps the
    // total wait so a few slow sources can't stall playback indefinitely.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), PREFER_MAX_WAIT_MS);
    const results = [];
    let nextIndex = 0;
    let verifiedCount = 0;
    let autoPlayFired = false;

    const probeOne = async (source) => {
      const key = getSourceProbeKey(source);
      const episodeUrl = source.episodes?.[this.episodeIndex];
      if (!episodeUrl) {
        const fail = { hasError: true, status: "failed", failureKind: "empty", message: "没有可用播放地址" };
        this.probeResults.set(key, fail);
        return { source, testResult: fail };
      }
      try {
        const probe = await api.probePlayback(episodeUrl, source.source, PROBE_TIMEOUT_MS, controller.signal);
        this.probeResults.set(key, probe);
        return { source, testResult: probe };
      } catch (e) {
        if (controller.signal.aborted) {
          // Deadline abort — record a timeout-style failure, not a crash.
          const fail = { hasError: true, status: "failed", failureKind: "timeout", message: "测速超时" };
          this.probeResults.set(key, fail);
          return { source, testResult: fail };
        }
        const fail = { hasError: true, status: "failed", failureKind: "unknown", message: String(e?.message || e) };
        this.probeResults.set(key, fail);
        return { source, testResult: fail };
      }
    };

    const maybeAutoPlay = (bestSoFar) => {
      if (autoPlayFired || !this.autoPlay || this.preferCancelled) return;
      if (verifiedCount < PREFER_MIN_VERIFIED_FOR_AUTOPLAY && this.probeDone < this.probeTotal) return;
      autoPlayFired = true;
      // Pick the best among results so far, then start playback.
      const verified = results.filter((r) => isVerifiedPlaybackResult(r.testResult));
      const selectable = verified.length ? verified
        : results.filter((r) => isPlayableFallbackResult(r.testResult));
      const best = selectable.length
        ? selectable.sort((a, b) => comparePlaybackMetrics(a.testResult, b.testResult))[0].source
        : bestSoFar || this.sources[0];
      this.currentSource = best;
      this._renderSourceList();
      this._renderEpisodes();
      this._setStatus(`✨ 已选「${this._escape(best.source_name || best.source)}」，准备播放`);
      // Fire and forget — do NOT await. Awaiting would block the worker from
      // probing the remaining sources. _startPlayback navigates to the player,
      // but the probe workers keep running in the background (they only hold
      // probeResults + the closure; detail.cleanup sets preferCancelled but
      // does not abort the in-flight fetches), so the source list fills in
      // with real data for when the user returns to detail.
      this._startPlayback(best, this.episodeIndex, { preferResume: true });
    };

    const worker = async () => {
      while (!controller.signal.aborted) {
        const i = nextIndex++;
        if (i >= this.sources.length) return;
        const r = await probeOne(this.sources[i]);
        results.push(r);
        this.probeDone++;
        if (isVerifiedPlaybackResult(r.testResult) && (r.testResult.startupTimeMs || Infinity) <= PROBE_TIMEOUT_MS) {
          verifiedCount++;
        }
        this._setStatus(`⚡ 正在优选最佳播放源…（${this.probeDone}/${this.probeTotal}）`);
        this._renderSourceList();
        // Persist probe results incrementally so a later detail re-mount
        // (e.g. after player exits) can restore them via _restoreFromCache
        // instead of starting from zero.
        this._saveCache();
        // Trigger auto-play once we have enough verified results (or all
        // probes are done with fewer). Background probes continue filling in.
        maybeAutoPlay(r.source);
      }
    };

    await Promise.all(Array.from({ length: Math.min(PREFER_CONCURRENCY, this.sources.length) }, () => worker()));
    clearTimeout(deadline);
    this.probeRunning = false;

    // Final selection: rank every result now that all probes are done.
    const verified = results.filter((r) => isVerifiedPlaybackResult(r.testResult));
    const selectable = verified.length ? verified
      : results.filter((r) => isPlayableFallbackResult(r.testResult));
    let best;
    if (selectable.length) {
      selectable.sort((a, b) => comparePlaybackMetrics(a.testResult, b.testResult));
      best = selectable[0].source;
    } else {
      best = this.sources[0];
    }
    this.currentSource = best;
    this._renderSourceList();
    this._renderEpisodes();
    this._setStatus(`✨ 已选「${this._escape(best.source_name || best.source)}」，准备播放`);
    // Enable the play button and focus it.
    const playBtn = this.container.querySelector('.btn[data-action="play"]');
    if (playBtn) {
      playBtn.disabled = false;
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      playBtn.classList.add("focused");
      playBtn.focus();
    }
    // If auto-play already fired above, don't start again. Otherwise fire now.
    if (!autoPlayFired && this.autoPlay && !this.preferCancelled) {
      await this._startPlayback(best, this.episodeIndex, { preferResume: true });
    }
  },

  _renderSourceList() {
    const wrap = this.container.querySelector("#sourceList");
    if (!wrap) return;
    if (!this.sources.length) {
      wrap.innerHTML = `<div class="empty-state">无可用源</div>`;
      return;
    }
    // Sort a copy by probe result quality (best first), keep unprobed at end by source order.
    const ranked = [...this.sources].sort((a, b) => {
      const ra = this.probeResults.get(getSourceProbeKey(a));
      const rb = this.probeResults.get(getSourceProbeKey(b));
      if (!ra && !rb) return 0;
      if (!ra) return 1;
      if (!rb) return -1;
      return comparePlaybackMetrics(ra, rb);
    });
    const items = ranked.map((src) => {
      const key = getSourceProbeKey(src);
      const r = this.probeResults.get(key);
      const isCurrent = this.currentSource && getSourceProbeKey(this.currentSource) === key;
      const probeCell = this._renderProbeCell(r);
      const epCount = Array.isArray(src.episodes) ? src.episodes.length : 0;
      return `
        <div class="source-row${isCurrent ? " current" : ""} focusable" data-action="switch-source" data-key="${this._escape(key)}">
          <div class="source-row-name">${this._escape(src.source_name || src.source)}</div>
          <div class="source-row-meta">${epCount} 集</div>
          <div class="source-row-probe">${probeCell}</div>
        </div>
      `;
    }).join("");
    wrap.innerHTML = `<div class="source-list">${items}</div>`;
    ScreenUtils.indexFocusables(wrap, ".focusable");
  },

  _renderProbeCell(r) {
    if (!r) return `<span class="probe-pending">待测速</span>`;
    if (r.hasError || r.status === "failed") {
      return `<span class="probe-failed">✕ ${this._escape(r.message || "失败").slice(0, 24)}</span>`;
    }
    if (isVerifiedPlaybackResult(r)) {
      const q = this._escape(r.quality || "—");
      const speed = r.speedKBps ? `${(r.speedKBps / 1024).toFixed(2)} MB/s` : (this._escape(r.loadSpeed || "") || "—");
      const ping = r.pingTime ? `${r.pingTime} ms` : "—";
      return `<span class="probe-ok">✓ ${q} · ${speed} · ${ping}</span>`;
    }
    if (isPlayableFallbackResult(r)) {
      return `<span class="probe-partial">◐ ${this._escape(r.message || "可播").slice(0, 24)}</span>`;
    }
    return `<span class="probe-partial">◐ ${this._escape(r.message || "部分").slice(0, 24)}</span>`;
  },

  _renderEpisodes() {
    const list = this.container.querySelector("#episodesList");
    const title = this.container.querySelector("#episodesTitle");
    if (!this.currentSource || !Array.isArray(this.currentSource.episodes) || this.currentSource.episodes.length <= 1) {
      list.style.display = "none";
      title.style.display = "none";
      return;
    }
    title.style.display = "block";
    list.style.display = "grid";
    list.innerHTML = this.currentSource.episodes.map((_, i) => `
      <div class="episode-item focusable" data-action="play-ep" data-index="${i}">第 ${i + 1} 集</div>
    `).join("");
    ScreenUtils.indexFocusables(list, ".focusable");
  },

  async _maybeFetchDetail() {
    if (!this.currentSource) return;
    try {
      const detail = await api.getVideoDetail(this.currentSource.source, String(this.currentSource.id));
      this.detail = detail;
      const cast = this.container.querySelector("#detailCast");
      if (cast) {
        const parts = [];
        if (detail.director) parts.push(`导演：${this._escape(detail.director)}`);
        if (detail.actor) parts.push(`主演：${this._escape(detail.actor)}`);
        if (detail.remarks) parts.push(this._escape(detail.remarks));
        cast.innerHTML = parts.join("<br>") || "—";
      }
      const desc = this.container.querySelector("#detailDesc");
      if (desc && detail.desc) desc.textContent = detail.desc;
      const tags = this.container.querySelector("#detailTags");
      if (tags) {
        const year = this._escape(detail.year || this.year || "");
        const t = ["movie", "tv"].includes(detail.type) ? (detail.type === "tv" ? "剧集" : "电影") : "";
        const ep = Array.isArray(detail.episodes) ? `${detail.episodes.length} 集` : "";
        tags.innerHTML = [year, t, ep].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
      }
    } catch (e) { /* best-effort */ }
  },

  async _startPlayback(source, episodeIndex, opts = {}) {
    if (!source || !Array.isArray(source.episodes) || !source.episodes.length) {
      showToast("无可用剧集");
      return;
    }
    this.preferCancelled = true; // prevent late autoplay after manual nav

    // Resume from the saved play record when available:
    //   - "preferResume" (auto-play / main Play button) jumps to the recorded
    //     episode + time.
    //   - an explicit episode pick only resumes time if it is the same episode.
    let index = Math.max(0, Math.min(episodeIndex, source.episodes.length - 1));
    let resumeTime = 0;
    const record = await this._lookupRecord(source);
    if (record) {
      const recSlot = Math.max(0, Math.min((record.index || 1) - 1, source.episodes.length - 1));
      if (opts.preferResume) {
        index = recSlot;
        resumeTime = record.play_time || 0;
      } else if (recSlot === index) {
        resumeTime = record.play_time || 0;
      }
    }

    Router.navigate("player", {
      title: source.title || this.title,
      sourceName: source.source_name || source.source,
      episodes: source.episodes,
      index,
      resumeTime,
      // Metadata the player needs to persist progress to /api/playrecords.
      record: {
        source: source.source,
        id: source.id,
        title: source.title || this.title,
        cover: source.poster || this.poster || "",
        source_name: source.source_name || source.source,
        year: source.year || this.year || "",
        total_episodes: source.episodes.length
      },
      // Pass through all sources + current probe results so the player can
      // offer source switching with the same ranking.
      allSources: this.sources,
      probeResults: Array.from(this.probeResults.entries()),
      currentSourceKey: getSourceProbeKey(source)
    });
  },

  // Look up the saved (device-local) play record for a movie.
  // Keyed per-movie (title|year), so any source for the same title shares
  // one record — the 3-pick algorithm can switch sources and still resume.
  _lookupRecord(source) {
    if (!source) return null;
    const records = LocalLibrary.getPlayRecords();
    return records[recordKeyFor(source)] || null;
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    if (code === 13) {
      const focused = this.container.querySelector(".focused");
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "play") {
        if (!this.currentSource) { showToast("尚未选出可播源"); return; }
        await this._startPlayback(this.currentSource, 0, { preferResume: true });
        return;
      }
      if (action === "play-ep") {
        const idx = Number(focused.dataset.index);
        if (!this.currentSource) return;
        this.episodeIndex = idx;
        await this._startPlayback(this.currentSource, idx);
        return;
      }
      if (action === "switch-source") {
        const key = focused.dataset.key;
        const src = this.sources.find((s) => getSourceProbeKey(s) === key);
        if (!src) return;
        this.currentSource = src;
        this.episodeIndex = 0;
        this._renderSourceList();
        this._renderEpisodes();
        this._setStatus(`已切换到「${this._escape(src.source_name || src.source)}」`);
        // Pull probe results for this source's episodes if missing.
        this._maybeFetchDetail();
        return;
      }
      if (action === "favorite") { await this._toggleFavorite(); return; }
      if (action === "refresh") {
        if (this.probeRunning) { showToast("测速进行中"); return; }
        this.probeResults = new Map();
        await this._probeAndPick();
        return;
      }
      if (action === "back") { Router.back(); return; }
      if (action === "nav-home") { Router.navigate("home", {}); return; }
      if (action === "nav-search") { Router.navigate("search", { q: this.title }); return; }
      if (action === "nav-library") { Router.navigate("library", {}); return; }
      if (action === "nav-settings") { Router.navigate("settings", {}); return; }
    }
  },

  _toggleFavorite() {
    const r = this.currentSource;
    if (!r) { showToast("尚未选定源"); return; }
    // Favorites are stored on-device (see localLibrary.js). Key uses the
    // DecoTV `${source}+${id}` convention.
    const key = `${r.source}+${r.id}`;
    if (LocalLibrary.isFavorited(key)) {
      LocalLibrary.deleteFavorite(key);
      showToast("已取消收藏");
      return;
    }
    LocalLibrary.addFavorite(key, {
      cover: r.poster || this.poster,
      title: r.title || this.title,
      source_name: r.source_name || r.source,
      total_episodes: Array.isArray(r.episodes) ? r.episodes.length : 0,
      search_title: r.title || this.title,
      year: r.year || this.year || ""
    });
    showToast("已收藏");
  },

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {
    this.preferCancelled = true;
    ScreenUtils.hide(this.container);
  }
};
