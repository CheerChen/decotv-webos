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
import { posterAttrs, hydratePosters } from "../../posterImage.js";
import { renderProbeCell } from "../../probeLabel.js";
import {
  getSourceProbeKey,
  rankSourcesByProbe
} from "../../../core/network/sourceRanking.js";
import {
  getPreferCache,
  pickBestPreferSource,
  runPreferEngine,
  savePreferCache
} from "../../../core/network/preferEngine.js";
import {
  getCachedRelated,
  setCachedRelated,
  getCachedDetail,
  setCachedDetail
} from "../../../core/storage/detailCache.js";

// Monochrome play glyph for the primary action (inherits color via currentColor).
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

// Play-record key is per-movie (title|year), not per-source. This matches
// the 3-pick algorithm: switching sources overwrites the same record, and
// "continue watching" resumes by title regardless of which source was used.
function recordKeyFor(source) {
  return LocalLibrary.recordKeyForTitle(source.title || source.search_title, source.year);
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
    this._relatedResults = [];
    this._relatedKeyword = "";
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
    const cached = getPreferCache(this.title, this.year);
    if (fromHistory && cached) {
      this._restoreFromCache(cached);
      return;
    }

    // Focus the primary action from the start: play is never disabled, and
    // pressing it mid-probe plays the best source measured so far.
    ScreenUtils.setInitialFocus(this.container.querySelector('.btn[data-action="play"]'));
    await this._searchAndPrefer();
    this._saveCache();
  },

  _saveCache() {
    if (this.mode !== "prefer" || !this.sources.length) return;
    savePreferCache({
      title: this.title,
      year: this.year,
      sources: this.sources,
      probeResults: this.probeResults,
      currentSourceKey: this.currentSource ? getSourceProbeKey(this.currentSource) : "",
    });
  },

  _restoreFromCache(cache) {
    this.sources = cache.sources;
    this.probeResults = new Map(cache.probeResults);
    this.currentSource = this.sources.find(
      (s) => getSourceProbeKey(s) === cache.currentSourceKey
    ) || this.sources[0];
    this._renderHeroMeta();
    this._maybeFetchDetail();
    this._renderSourceList();
    this._renderEpisodes();
    this._setStatus(`已选「${escapeHtml(this.currentSource?.source_name || this.currentSource?.source || "")}」`);
    this._updatePlayButton();
    this._updateFavoriteButton();
    const playBtn = this.container.querySelector('.btn[data-action="play"]');
    if (playBtn) ScreenUtils.setFocus(playBtn, this.container);
    // Sources the previous visit never got to (auto-play moved the user into
    // the player mid-run) are measured now, so the list eventually shows real
    // metrics for every source. Fire and forget — the cached pick stands.
    if (this.sources.some((s) => !this.probeResults.has(getSourceProbeKey(s)))) {
      this._probeAndPick({ reselect: false });
    }
  },

  _renderSkeleton() {
    const poster = posterAttrs(this.poster);
    const title = escapeHtml(this.title);
    // Episodes sit above the (often long) source list so they stay reachable
    // without scrolling past every probe row. Prefer-status stays in the hero.
    //
    // Hero actions carry exactly two buttons: the one primary action (play,
    // never disabled — pressing it mid-probe plays the best source so far) and
    // favorite. Back lives on the remote's back key; refresh moved next to the
    // source list it operates on.
    this.container.innerHTML = `
      ${renderNavHeader()}
      <div class="content-scroll" id="detailScroll">
        <div class="detail-hero">
          <img class="detail-poster" id="detailPoster" ${poster} alt="" onerror="this.style.opacity=0.15" />
          <div class="detail-info">
            <h1 class="detail-title">${title}</h1>
            <div class="detail-tags" id="detailTags"></div>
            <div class="detail-related" id="detailRelated" style="display:none;">
              <span class="detail-related-label">系列作品</span>
              <div class="detail-related-badges" id="detailRelatedBadges"></div>
            </div>
            <div class="detail-desc" id="detailDesc"></div>
            <div class="detail-cast" id="detailCast"></div>
            <div id="detailStatus" class="detail-status">准备中…</div>
            <div class="detail-actions" id="detailActions">
              <button class="btn primary focusable" data-action="play">${PLAY_ICON}<span>播放</span></button>
              <button class="btn focusable" data-action="favorite">收藏</button>
            </div>
          </div>
        </div>
        <div class="detail-section-head" id="episodesHead" style="display:none;">
          <span class="section-title">剧集</span>
          <span class="section-hint" id="episodesHint"></span>
        </div>
        <div class="episodes-list" id="episodesList" style="display:none;"></div>
        <div class="detail-section-head">
          <span class="section-title">播放源</span>
          <button class="btn chip ghost focusable" data-action="refresh">重新测速</button>
          <span class="section-hint">OK 直接播放 · 测速后按质量排序</span>
        </div>
        <div id="sourceList"><div class="empty-state">正在搜索播放源…</div></div>
      </div>
    `;
    bindNavClicks(this.container);
    this._updatePlayButton();
    this._updateFavoriteButton();
  },

  // Saved play record for this title (per-movie key, any source).
  _playRecord() {
    const key = this.currentSource
      ? recordKeyFor(this.currentSource)
      : LocalLibrary.recordKeyForTitle(this.title, this.year);
    return LocalLibrary.getPlayRecords()[key] || null;
  },

  // The play button announces what preferResume will actually do, instead of
  // silently jumping to episode 3 at 12:34.
  _updatePlayButton() {
    const btn = this.container?.querySelector('.btn[data-action="play"]');
    if (!btn) return;
    const record = this._playRecord();
    let label = "播放";
    if (record && (Number(record.play_time) > 0 || Number(record.index) > 1)) {
      label = Number(record.total_episodes) > 1
        ? `继续播放 第 ${record.index} 集`
        : "继续播放";
    }
    btn.innerHTML = `${PLAY_ICON}<span>${escapeHtml(label)}</span>`;
  },

  _updateFavoriteButton() {
    const btn = this.container?.querySelector('.btn[data-action="favorite"]');
    if (!btn) return;
    const r = this.currentSource;
    const on = r ? LocalLibrary.isFavorited(`${r.source}+${r.id}`) : false;
    btn.textContent = on ? "已收藏" : "收藏";
  },

  // Update hero poster when a better cover arrives (history entry without
  // poster, search result, or /api/detail). Keeps this.poster in sync.
  _setPoster(url) {
    if (!url || url === this.poster) return;
    this.poster = url;
    const img = this.container?.querySelector("#detailPoster");
    if (!img || !url) return;
    img.style.opacity = "1";
    // Hand it back to the same path the templates use, so the fetch goes
    // through the service rather than being attempted by the webview.
    img.dataset.poster = url;
    hydratePosters(this.container);
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

    this._maybeFetchRelatedTitles();
  },

  // Related-series badges: take the first space-separated segment of the
  // current title as a search keyword, hit /api/search once, and render every
  // distinct result (deduplicated by title, filtered to prefix matches,
  // excluding the current title) as a jump badge. Each badge carries the full
  // search result so clicking it enters detail in single-source mode with no
  // re-search. No heuristic guessing — the server returns only titles that
  // actually have playable sources.
  _relatedResults: [],
  _relatedKeyword: "",   // dedup guard: keyword already searched this mount

  // In prefer mode the related-titles search is deferred until probe finishes
  // (onDone) to avoid competing with the 8-way probe burst for server time.
  // In single mode it fires immediately — only 1 search + 1 detail request.
  _maybeFetchRelatedTitles() {
    if (this.mode === "prefer" && this.probeRunning) return;
    this._fetchRelatedTitles();
  },

  _fetchRelatedTitles() {
    const wrap = this.container?.querySelector("#detailRelated");
    const badgesEl = this.container?.querySelector("#detailRelatedBadges");
    if (!wrap || !badgesEl) return;
    const fullTitle = this.currentSource?.title
      || this.currentSource?.search_title
      || this.title
      || "";
    // The keyword is the first space-separated segment if the title has a
    // space, otherwise the full title. A bare title like "进击的巨人" is a
    // valid keyword — searching it returns adjacent seasons / derivatives.
    const sp = fullTitle.indexOf(" ");
    const keyword = (sp > 0 ? fullTitle.slice(0, sp) : fullTitle).trim();
    if (!keyword) { wrap.style.display = "none"; return; }

    // Dedup within a single mount: _renderHeroMeta fires multiple times during
    // the prefer flow (null → first hit → best). The keyword is the same each
    // time, so skip once we have already dispatched a fetch for it.
    if (this._relatedKeyword === keyword) return;
    this._relatedKeyword = keyword;

    // Cache hit → render immediately, no network request. The cache is keyed
    // by keyword, so the same keyword never fetches twice across visits.
    const cached = getCachedRelated(keyword);
    if (cached) {
      this._renderRelatedBadges(cached, fullTitle, wrap, badgesEl);
      return;
    }

    const epoch = this._mountEpoch;
    api.searchVideos(keyword).then((data) => {
      if (epoch !== this._mountEpoch) return; // stale — user navigated away
      const related = this._filterRelatedResults(data, keyword, fullTitle);
      setCachedRelated(keyword, related);
      this._renderRelatedBadges(related, fullTitle, wrap, badgesEl);
    }).catch(() => {
      if (epoch !== this._mountEpoch) return;
      wrap.style.display = "none";
    });
  },

  // Filter + dedup + sort the raw search response into a badge-ready list.
  _filterRelatedResults(data, keyword, fullTitle) {
    const results = Array.isArray(data?.results) ? data.results : [];
    const byTitle = new Map();
    const baseLen = keyword.length;
    for (const r of results) {
      const t = (r.title || "").trim();
      if (!t) continue;
      if (!t.startsWith(keyword)) continue;
      if (t === fullTitle.trim()) continue;
      if (t.length > baseLen * 3 + 6) continue;
      const prev = byTitle.get(t);
      const prevEps = prev && Array.isArray(prev.episodes) ? prev.episodes.length : 0;
      const curEps = Array.isArray(r.episodes) ? r.episodes.length : 0;
      if (!prev || curEps > prevEps) byTitle.set(t, r);
    }
    return Array.from(byTitle.values()).sort((a, b) => {
      const ea = Array.isArray(a.episodes) ? a.episodes.length : 0;
      const eb = Array.isArray(b.episodes) ? b.episodes.length : 0;
      if (eb !== ea) return eb - ea;
      const ya = Number(a.year) || 0;
      const yb = Number(b.year) || 0;
      return yb - ya;
    }).slice(0, 12);
  },

  // Render the badge row from a (possibly cached) result list. The current
  // title is excluded at render time so a cached list stays correct even when
  // the user navigates between seasons of the same series.
  _renderRelatedBadges(related, fullTitle, wrap, badgesEl) {
    const filtered = related.filter((r) => (r.title || "").trim() !== fullTitle.trim());
    this._relatedResults = filtered;
    if (!filtered.length) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    badgesEl.innerHTML = filtered.map((r, i) =>
      `<button class="btn chip ghost focusable" data-action="open-related" data-index="${i}">${escapeHtml(r.title)}</button>`
    ).join("");
    ScreenUtils.indexFocusables(badgesEl, ".focusable");
  },

  async _searchAndPrefer() {
    this._setStatus("🔍 正在搜索播放源…");
    try {
      await this._runPreferEngine();
    } catch (e) {
      this._setStatus(`搜索失败：${escapeHtml(e?.message || e)}`);
    }
  },

  // Run a probe-only continuation when a cached detail page has missing metrics.
  async _probeAndPick({ reselect = true } = {}) {
    if (!this.sources.length) return;
    await this._runPreferEngine({
      reselect,
      initialSources: this.sources,
      existingProbeResults: this.probeResults,
    });
  },

  async _runPreferEngine({
    reselect = true,
    initialSources = null,
    existingProbeResults = new Map(),
  } = {}) {
    const epoch = this._mountEpoch;
    return runPreferEngine({
      title: this.title,
      year: this.year,
      episodeIndex: this.episodeIndex,
      autoPlay: reselect ? this.autoPlay : false,
      reselect,
      initialSources,
      existingProbeResults,
      searchVideos: (title) => api.searchVideos(title),
      probePlayback: (...args) => api.probePlayback(...args),
      isStale: () => epoch !== this._mountEpoch,
      canAutoPlay: () => !this.preferCancelled,
      onSources: ({ sources, probeResults }) => {
        this.sources = sources;
        this.probeResults = probeResults;
        this.probeRunning = Boolean(sources.length);
        this.probeTotal = sources.length;
        this.probeDone = Array.from(probeResults.keys()).length;
        if (!sources.length) {
          this._setStatus("未找到匹配的播放源");
          this.container.querySelector("#sourceList").innerHTML = `<div class="empty-state">没有「${escapeHtml(this.title)}」的可用源</div>`;
          return;
        }
        // Fill missing cover + hero meta from the first search hit that has data.
        if (!this.poster) {
          const withPoster = sources.find((s) => s.poster);
          if (withPoster?.poster) this._setPoster(withPoster.poster);
        }
        if (!this.currentSource && sources[0]) this.currentSource = sources[0];
        this._renderHeroMeta();
        this._renderSourceList();
      },
      onProgress: ({ sources, probeResults, done, total }) => {
        if (epoch !== this._mountEpoch) return;
        this.sources = sources;
        this.probeResults = probeResults;
        this.probeRunning = true;
        this.probeDone = done;
        this.probeTotal = total;
        this._setStatus(`⚡ 正在优选最佳播放源…（${done}/${total}）`);
        this._renderSourceList();
        this._saveCache();
      },
      onPick: ({ source }) => {
        if (epoch !== this._mountEpoch || this.preferCancelled) return;
        this.currentSource = source;
        this._renderSourceList();
        this._renderEpisodes();
        this._setStatus(`✨ 已选「${escapeHtml(source.source_name || source.source)}」，准备播放`);
        // Do not await: background workers must continue filling probe metrics.
        this._startPlayback(source, this.episodeIndex, { preferResume: true });
      },
      onDone: ({ sources, probeResults, best, reselect: shouldReselect }) => {
        if (epoch !== this._mountEpoch || !best) return;
        this.sources = sources;
        this.probeResults = probeResults;
        this.probeRunning = false;
        this.probeDone = this.probeTotal;
        if (shouldReselect) {
          this.currentSource = best;
          if (best.poster) this._setPoster(best.poster);
          this._renderHeroMeta();
        }
        this._renderSourceList();
        this._renderEpisodes();
        this._maybeFetchDetail();
        this._saveCache();
        this._setStatus(shouldReselect
          ? `✨ 已选「${escapeHtml(best.source_name || best.source)}」，准备播放`
          : `已选「${escapeHtml(this.currentSource?.source_name || this.currentSource?.source || "")}」`);
        this._updatePlayButton();
        this._updateFavoriteButton();
        // Keep the primary action focused only for a fresh run still visible
        // on detail and only when the user has not moved elsewhere.
        if (shouldReselect && Router.current === "detail") {
          const focusedNow = this.container.querySelector(".focused");
          const playBtn = this.container.querySelector('.btn[data-action="play"]');
          if (playBtn && (!focusedNow || focusedNow === playBtn)) {
            ScreenUtils.setFocus(playBtn, this.container);
          }
        }
      },
    });
  },

  _renderSourceList() {
    const wrap = this.container.querySelector("#sourceList");
    if (!wrap) return;
    if (!this.sources.length) {
      wrap.innerHTML = `<div class="empty-state">无可用源</div>`;
      return;
    }
    // Sort a copy by probe result quality (best first), keep unprobed at end by source order.
    const ranked = rankSourcesByProbe(this.sources, this.probeResults);
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
    return renderProbeCell(r);
  },

  _renderEpisodes() {
    const list = this.container.querySelector("#episodesList");
    const head = this.container.querySelector("#episodesHead");
    if (!this.currentSource || !Array.isArray(this.currentSource.episodes) || this.currentSource.episodes.length <= 1) {
      list.style.display = "none";
      head.style.display = "none";
      return;
    }
    const eps = this.currentSource.episodes;
    const record = this._playRecord();
    const resumeIdx = record && Number(record.index) >= 1
      ? Math.min(Number(record.index) - 1, eps.length - 1)
      : -1;
    head.style.display = "flex";
    const hint = this.container.querySelector("#episodesHint");
    if (hint) {
      hint.textContent = `共 ${eps.length} 集${resumeIdx >= 0 ? ` · 上次看到第 ${resumeIdx + 1} 集` : ""}`;
    }
    list.style.display = "grid";
    list.innerHTML = eps.map((_, i) => `
      <div class="episode-item${i === resumeIdx ? " resume" : ""} focusable" data-action="play-ep" data-index="${i}">第 ${i + 1} 集</div>
    `).join("");
    ScreenUtils.indexFocusables(list, ".focusable");
  },

  async _maybeFetchDetail() {
    if (!this.currentSource) return;
    const src = this.currentSource.source;
    const id = String(this.currentSource.id);
    // Cache hit — skip the network round-trip. 24h TTL means a new episode
    // added on the server appears at most 24h late on a repeat visit.
    const cached = getCachedDetail(src, id);
    if (cached) {
      this._applyDetail(cached);
      return;
    }
    try {
      const detail = await api.getVideoDetail(src, id);
      setCachedDetail(src, id, detail);
      this._applyDetail(detail);
    } catch (e) { /* best-effort — search-hit meta already shown */ }
  },

  _applyDetail(detail) {
    this.detail = detail;
    const cover = detail.poster || detail.cover || this.currentSource.poster;
    if (cover && !/\/logo\.(jpg|png|webp)/i.test(cover) && !/static\/images\/logo/i.test(cover)) {
      this._setPoster(cover);
    }
    this._renderHeroMeta();
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
        // Mid-probe, currentSource is still the tentative first hit — rank
        // whatever has been measured so far instead. A wrong pick is cheap:
        // the player fails over automatically.
        const bestNow = pickBestPreferSource(this.sources, this.probeResults);
        const src = this.probeRunning
          ? (bestNow || this.currentSource)
          : (this.currentSource || bestNow);
        if (!src) { showToast("正在搜索播放源…"); return; }
        this.currentSource = src;
        await this._startPlayback(src, 0, { preferResume: true });
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
        // Keep Back → detail restoration aligned with the source the user just
        // chose before leaving this screen for playback.
        this._saveCache();
        await this._startPlayback(src, 0, { preferResume: true });
        return;
      }
      if (action === "favorite") { await this._toggleFavorite(); return; }
      if (action === "open-related") {
        const idx = Number(focused.dataset.index);
        const r = this._relatedResults[idx];
        if (!r) return;
        // Enter prefer mode: search all sources, probe, pick best — same
        // flow as entering from home/douban. Passing the search result's
        // title/year/poster gives the prefer engine what it needs to filter
        // and the hero something to show while probing.
        Router.navigate("detail", {
          title: r.title,
          poster: r.poster || "",
          year: r.year || "",
          autoPlay: true
        });
        return;
      }
      if (action === "refresh") {
        if (this.probeRunning) { showToast("测速进行中"); return; }
        this.probeResults = new Map();
        await this._probeAndPick();
        return;
      }
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
      this._updateFavoriteButton();
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
    this._updateFavoriteButton();
    showToast("已收藏");
  },

  cleanup() {
    this.preferCancelled = true;
    ScreenUtils.hide(this.container);
  }
};
