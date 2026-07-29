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
import { LibrarySync } from "../../../core/storage/librarySync.js";
import { showToast } from "../../toast.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { escapeHtml } from "../../utils.js";
import {
  comparePlaybackMetrics,
  getQualityRank,
  getSourceProbeKey,
  isPlayableFallbackResult,
  isVerifiedPlaybackResult
} from "../../../core/network/sourceRanking.js";

const PROBE_TIMEOUT_MS = 8000;
// Probes are latency-bound on the upstream CDN, not on the DecoTV server, so
// widening the pool is close to free: 8 in flight was measured costing the same
// wall time as 3 while covering 2.7x as many sources. Kept below the point
// where sources start contending for bandwidth and skewing their own speedKBps
// (the secondary ranking key), which showed up clearly at 34-way concurrency.
const PREFER_CONCURRENCY = 8;
// Soft deadline: stop making the user wait and play the best candidate so far.
// Does NOT stop probing.
const PREFER_MAX_WAIT_MS = 12000;
// Hard deadline: the single point where outstanding probes are abandoned.
// Sized so a source-rich title (30+) can finish in the background and leave a
// fully measured source list behind for when the user comes back.
const PREFER_BACKGROUND_MAX_MS = 60000;
// Minimum number of verified probe results before auto-play kicks in.
// The probe keeps running in the background after this threshold is met so
// the source list fills in with real speed/latency for every source.
// 4 rather than 3: replaying captured probe arrivals showed 3 settling for a
// 720p source 125ms before a 1080p one at 10x the throughput arrived. Beyond 4
// the pick stopped changing, so the extra wait buys nothing.
const PREFER_MIN_VERIFIED_FOR_AUTOPLAY = 4;
// Resolution that ends the wait on its own. Quality is the primary ranking key
// and comes straight from the manifest, so once a source this good is verified
// further probing can only refine the speed tie-break. Measured ~1s faster to
// first frame than waiting for the count on titles whose probes are slow.
const PREFER_QUALITY_SHORTCUT_RANK = 1080;

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
  _mountEpoch: 0,        // race guard: incremented on each mount; stale probe workers check and bail

  async mount(params = {}, opts = {}) {
    this._mountEpoch++;
    const epoch = this._mountEpoch;
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
    this._renderHeroMeta(); // year from entry params; enriched as sources/detail arrive
    ScreenUtils.show(this.container);

    if (this.mode === "single") {
      // Already have a source; optionally fetch detail for richer metadata.
      this._renderHeroMeta();
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
    this._renderHeroMeta();
    this._maybeFetchDetail();
    this._renderSourceList();
    this._renderEpisodes();
    this._setStatus(`已选「${escapeHtml(this.currentSource?.source_name || this.currentSource?.source || "")}」`);
    const playBtn = this.container.querySelector('.btn[data-action="play"]');
    if (playBtn) {
      playBtn.disabled = false;
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      playBtn.classList.add("focused");
      playBtn.focus();
    }
    // Sources the previous visit never got to (auto-play moved the user into
    // the player mid-run) are measured now, so the list eventually shows real
    // metrics for every source. Fire and forget — the cached pick stands.
    if (this.sources.some((s) => !this.probeResults.has(getSourceProbeKey(s)))) {
      this._probeAndPick({ reselect: false });
    }
  },

  _renderSkeleton() {
    const poster = api.getImageProxyUrl(this.poster);
    const title = escapeHtml(this.title);
    // Episodes sit above the (often long) source list so they stay reachable
    // without scrolling past every probe row. Prefer-status stays in the hero.
    this.container.innerHTML = `
      ${renderNavHeader()}
      <div class="content-scroll" id="detailScroll">
        <div class="detail-hero">
          <img class="detail-poster" id="detailPoster" src="${poster || ""}" alt="" onerror="this.style.opacity=0.15" />
          <div class="detail-info">
            <h1 class="detail-title">${title}</h1>
            <div class="detail-tags" id="detailTags"></div>
            <div class="detail-desc" id="detailDesc"></div>
            <div class="detail-cast" id="detailCast"></div>
            <div id="detailStatus" class="detail-status">准备中…</div>
            <div class="detail-actions" id="detailActions">
              <button class="btn primary focusable" data-action="play" disabled>播放</button>
              <button class="btn focusable" data-action="favorite">收藏</button>
              <button class="btn ghost focusable" data-action="refresh">重新测速</button>
              <button class="btn ghost focusable" data-action="back">返回</button>
            </div>
          </div>
        </div>
        <div class="section-title" id="episodesTitle" style="display:none;">剧集列表</div>
        <div class="episodes-list" id="episodesList" style="display:none;"></div>
        <div class="section-title">播放源（测速后按质量排序）</div>
        <div id="sourceList"><div class="empty-state">正在搜索播放源…</div></div>
      </div>
    `;
    bindNavClicks(this.container);
  },

  // Update hero poster when a better cover arrives (history entry without
  // poster, search result, or /api/detail). Keeps this.poster in sync.
  _setPoster(url) {
    if (!url || url === this.poster) return;
    this.poster = url;
    const img = this.container?.querySelector("#detailPoster");
    if (!img) return;
    const src = api.getImageProxyUrl(url);
    if (!src) return;
    img.style.opacity = "1";
    img.src = src;
  },

  _setStatus(text) {
    const el = this.container?.querySelector("#detailStatus");
    if (el) el.textContent = text;
  },

  // Fill hero tags / synopsis / cast from whatever we have so far.
  // Search hits usually carry year, type_name, desc, remarks; /api/detail is
  // best-effort and often sparse on this server — do not wait on it alone.
  _renderHeroMeta() {
    if (!this.container) return;
    const src = this.currentSource || null;
    const detail = this.detail || null;

    const year = String(detail?.year || src?.year || this.year || "").trim();
    const typeLabel = String(
      detail?.type_name
      || src?.type_name
      || (detail?.type === "tv" ? "剧集" : detail?.type === "movie" ? "电影" : "")
      || ""
    ).trim();
    const epCount = Array.isArray(detail?.episodes)
      ? detail.episodes.length
      : Array.isArray(src?.episodes)
        ? src.episodes.length
        : 0;
    const quality = String(src?.quality_tag || detail?.resolution || "").trim();
    const className = String(detail?.class || src?.class || "").trim();

    const tags = this.container.querySelector("#detailTags");
    if (tags) {
      const parts = [
        year,
        typeLabel,
        className && className !== typeLabel ? className : "",
        epCount > 1 ? `${epCount} 集` : "",
        quality
      ].filter(Boolean);
      // Deduplicate while keeping order (e.g. type_name and "电影" both present).
      const seen = new Set();
      const uniq = [];
      for (const p of parts) {
        if (seen.has(p)) continue;
        seen.add(p);
        uniq.push(p);
      }
      tags.innerHTML = uniq.map((x) => `<span>${escapeHtml(x)}</span>`).join("");
    }

    const desc = this.container.querySelector("#detailDesc");
    if (desc) {
      const text = String(detail?.desc || src?.desc || "").trim();
      desc.textContent = text;
      desc.style.display = text ? "" : "none";
    }

    const cast = this.container.querySelector("#detailCast");
    if (cast) {
      const lines = [];
      const director = detail?.director || src?.director;
      const actor = detail?.actor || src?.actor;
      const remarks = detail?.remarks || src?.remarks;
      if (director) lines.push(`导演：${escapeHtml(String(director))}`);
      if (actor) lines.push(`主演：${escapeHtml(String(actor))}`);
      if (remarks) lines.push(escapeHtml(String(remarks)));
      cast.innerHTML = lines.join("<br>");
      cast.style.display = lines.length ? "" : "none";
    }
  },

  async _searchAndPrefer() {
    const epoch = this._mountEpoch;
    this._setStatus("🔍 正在搜索播放源…");
    try {
      const data = await api.searchVideos(this.title);
      if (epoch !== this._mountEpoch) return; // stale — newer mount won
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
        this.container.querySelector("#sourceList").innerHTML = `<div class="empty-state">没有「${escapeHtml(this.title)}」的可用源</div>`;
        return;
      }
      // Fill missing cover + hero meta from the first search hit that has data.
      if (!this.poster) {
        const withPoster = this.sources.find((s) => s.poster);
        if (withPoster?.poster) this._setPoster(withPoster.poster);
      }
      if (!this.currentSource && this.sources[0]) {
        // Tentative source for meta only; probe will reassign the real pick.
        this.currentSource = this.sources[0];
      }
      this._renderHeroMeta();
      this._renderSourceList();
      await this._probeAndPick();
    } catch (e) {
      this._setStatus(`搜索失败：${escapeHtml(e?.message || e)}`);
    }
  },

  // reselect:false leaves the current source alone and only fills in metrics —
  // used when resuming a run that an earlier visit left unfinished.
  async _probeAndPick({ reselect = true } = {}) {
    if (!this.sources.length) return;
    // Probe only what has no result yet, so a resumed run picks up where the
    // previous one stopped instead of re-measuring everything.
    const pending = this.sources.filter((s) => !this.probeResults.has(getSourceProbeKey(s)));
    if (!pending.length) return;
    const epoch = this._mountEpoch;
    this.probeRunning = true;
    this.probeTotal = this.sources.length;
    this.probeDone = this.probeTotal - pending.length;
    this._setStatus(`⚡ 正在优选最佳播放源…（${this.probeDone}/${this.probeTotal}）`);

    // No short-circuit abort: every source is probed so the source list shows
    // real speed/latency for all of them. autoPlay fires once after at least
    // PREFER_MIN_VERIFIED_FOR_AUTOPLAY verified results are in (or when all
    // probes finish if fewer than that verify). Two deadlines, deliberately
    // separate: the soft one only forces the auto-play decision, the hard one
    // is the sole point where in-flight probes are actually abandoned.
    const controller = new AbortController();
    const hardDeadline = setTimeout(() => controller.abort(), PREFER_BACKGROUND_MAX_MS);
    const results = [];
    let nextIndex = 0;
    let verifiedCount = 0;
    let autoPlayFired = false;
    let autoPlayDeadlineReached = false;
    let qualityShortcutHit = false;

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
        if (epoch !== this._mountEpoch) return { source, testResult: { stale: true } }; // stale
        this.probeResults.set(key, probe);
        return { source, testResult: probe };
      } catch (e) {
        if (epoch !== this._mountEpoch) return { source, testResult: { stale: true } }; // stale
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
      if (epoch !== this._mountEpoch) return; // stale — don't start playback on wrong movie
      if (verifiedCount < PREFER_MIN_VERIFIED_FOR_AUTOPLAY
        && this.probeDone < this.probeTotal
        && !autoPlayDeadlineReached
        && !qualityShortcutHit) return;
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
      this._setStatus(`✨ 已选「${escapeHtml(best.source_name || best.source)}」，准备播放`);
      // Fire and forget — do NOT await. Awaiting would block the worker from
      // probing the remaining sources. _startPlayback navigates to the player,
      // but the probe workers keep running in the background (they only hold
      // probeResults + the closure; detail.cleanup sets preferCancelled but
      // does not abort the in-flight fetches), so the source list fills in
      // with real data for when the user returns to detail.
      this._startPlayback(best, this.episodeIndex, { preferResume: true });
    };

    // Soft deadline: force the auto-play decision with whatever has arrived.
    // Probing deliberately keeps running afterwards.
    const softDeadline = setTimeout(() => {
      autoPlayDeadlineReached = true;
      maybeAutoPlay(null);
    }, PREFER_MAX_WAIT_MS);

    const worker = async () => {
      while (!controller.signal.aborted) {
        if (epoch !== this._mountEpoch) return; // stale — newer mount won
        const i = nextIndex++;
        if (i >= pending.length) return;
        const r = await probeOne(pending[i]);
        if (r.testResult?.stale) return; // stale — bail
        results.push(r);
        this.probeDone++;
        if (isVerifiedPlaybackResult(r.testResult) && (r.testResult.startupTimeMs || Infinity) <= PROBE_TIMEOUT_MS) {
          verifiedCount++;
        }
        // A source this good ends the wait by itself — see the constant.
        if (isVerifiedPlaybackResult(r.testResult)
          && getQualityRank(r.testResult) >= PREFER_QUALITY_SHORTCUT_RANK) {
          qualityShortcutHit = true;
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

    await Promise.all(Array.from({ length: Math.min(PREFER_CONCURRENCY, pending.length) }, () => worker()));
    clearTimeout(hardDeadline);
    clearTimeout(softDeadline);
    if (epoch !== this._mountEpoch) return; // stale — don't finalize on wrong movie
    this.probeRunning = false;

    // Final selection ranks every result held, including ones carried in from a
    // previous visit, not just the sources this run happened to probe.
    const all = this.sources
      .map((source) => ({ source, testResult: this.probeResults.get(getSourceProbeKey(source)) }))
      .filter((r) => r.testResult);
    const verified = all.filter((r) => isVerifiedPlaybackResult(r.testResult));
    const selectable = verified.length ? verified
      : all.filter((r) => isPlayableFallbackResult(r.testResult));
    let best;
    if (selectable.length) {
      selectable.sort((a, b) => comparePlaybackMetrics(a.testResult, b.testResult));
      best = selectable[0].source;
    } else {
      best = this.sources[0];
    }
    if (reselect) {
      this.currentSource = best;
      if (best?.poster) this._setPoster(best.poster);
      this._renderHeroMeta();
    }
    this._renderSourceList();
    this._renderEpisodes();
    this._maybeFetchDetail();
    this._saveCache();
    this._setStatus(reselect
      ? `✨ 已选「${escapeHtml(best.source_name || best.source)}」，准备播放`
      : `已选「${escapeHtml(this.currentSource?.source_name || this.currentSource?.source || "")}」`);
    // Probing now outlives the detail screen: auto-play may already have moved
    // the user into the player, and a resumed run finishes while they are
    // browsing the source list. Only grab focus for a fresh run that the user
    // is actually waiting on, and only while detail is the visible route.
    if (reselect && Router.current === "detail") {
      const playBtn = this.container.querySelector('.btn[data-action="play"]');
      if (playBtn) {
        playBtn.disabled = false;
        this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
        playBtn.classList.add("focused");
        playBtn.focus();
      }
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
        <div class="source-row${isCurrent ? " current" : ""} focusable" data-action="switch-source" data-key="${escapeHtml(key)}">
          <div class="source-row-name">${escapeHtml(src.source_name || src.source)}</div>
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
      return `<span class="probe-failed">✕ ${escapeHtml(r.message || "失败").slice(0, 24)}</span>`;
    }
    if (isVerifiedPlaybackResult(r)) {
      const q = escapeHtml(r.quality || "—");
      const speed = r.speedKBps ? `${(r.speedKBps / 1024).toFixed(2)} MB/s` : (escapeHtml(r.loadSpeed || "") || "—");
      const ping = r.pingTime ? `${r.pingTime} ms` : "—";
      return `<span class="probe-ok">✓ ${q} · ${speed} · ${ping}</span>`;
    }
    if (isPlayableFallbackResult(r)) {
      return `<span class="probe-partial">◐ ${escapeHtml(r.message || "可播").slice(0, 24)}</span>`;
    }
    return `<span class="probe-partial">◐ ${escapeHtml(r.message || "部分").slice(0, 24)}</span>`;
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
      // Prefer detail/source poster when the hero still has none (common when
      // entering from continue-watching without a cover field on the record).
      // Skip known placeholder logos that some sites return as "poster".
      const cover = detail.poster || detail.cover || this.currentSource.poster;
      if (cover && !/\/logo\.(jpg|png|webp)/i.test(cover) && !/static\/images\/logo/i.test(cover)) {
        this._setPoster(cover);
      }
      this._renderHeroMeta();
    } catch (e) { /* best-effort — search-hit meta already shown */ }
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

  // Look up the saved play record for a movie.
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
        this.detail = null;
        if (src.poster) this._setPoster(src.poster);
        this._renderHeroMeta();
        this._renderSourceList();
        this._renderEpisodes();
        this._setStatus(`已切换到「${escapeHtml(src.source_name || src.source)}」`);
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
      if (handleNavAction(action)) return;
    }
  },

  _toggleFavorite() {
    const r = this.currentSource;
    if (!r) { showToast("尚未选定源"); return; }
    // Key uses the DecoTV `${source}+${id}` convention, which is also what the
    // server expects, so favorites mirror across without translation.
    const key = `${r.source}+${r.id}`;
    if (LocalLibrary.isFavorited(key)) {
      LocalLibrary.deleteFavorite(key);
      LibrarySync.removeFavorite(key);
      showToast("已取消收藏");
      return;
    }
    const favorite = {
      cover: r.poster || this.poster,
      title: r.title || this.title,
      source_name: r.source_name || r.source,
      total_episodes: Array.isArray(r.episodes) ? r.episodes.length : 0,
      search_title: r.title || this.title,
      year: r.year || this.year || ""
    };
    LocalLibrary.addFavorite(key, favorite);
    LibrarySync.pushFavorite(key, favorite);
    showToast("已收藏");
  },

  cleanup() {
    this.preferCancelled = true;
    ScreenUtils.hide(this.container);
  }
};
