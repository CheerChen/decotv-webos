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
import { escapeHtml, formatVotes } from "../../utils.js";
import { posterAttrs, hydratePosters } from "../../posterImage.js";
import { renderProbeCell } from "../../probeLabel.js";
import { readStreamResolution } from "../../../core/playback/streamResolution.js";
import {
  getSourceProbeKey,
  rankSourcesByProbe,
  episodeLabel,
  hasVersionLabels
} from "../../../core/network/sourceRanking.js";
import {
  getPreferSession,
  pickBestPreferSource,
  PREFER_CONCURRENCY,
  PREFER_PLAYBACK_CONCURRENCY,
  runPreferEngine,
  startPreferSession
} from "../../../core/network/preferEngine.js";
import {
  getCachedRelated,
  setCachedRelated,
  getCachedDetail,
  setCachedDetail
} from "../../../core/storage/detailCache.js";
import { normalizeWork, rememberWork, lookupWork } from "../../../core/catalog/work.js";
import { getWorkDetails, getWorkBackdrop } from "../../../core/catalog/workDetails.js";
import { getHeroStyle } from "../../../core/storage/heroStyle.js";
import { loadEpisodeMeta } from "../../../core/catalog/episodeMeta.js";
import { relatedKeyword, filterRelatedResults, excludeRelated } from "./relatedTitles.js";

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
  probeResults: new Map(),  // sourceKey -> probe result (the session's Map in prefer mode)
  preferSession: null,      // shared with the player; see preferEngine startPreferSession
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
    this.preferSession = null;
    this.probeRunning = false;
    this.probeDone = 0;
    this.probeTotal = 0;
    this.preferCancelled = false;
    this.searching = false;
    this.noSources = false;
    this.detail = null;
    this.episodeIndex = 0;
    this._relatedResults = [];
    this._relatedKeyword = "";
    this._lastSearchKeyword = ""; // shared raw search response for related badges
    this._lastSearchData = null;
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

    // The work this page is about, in the catalog that listed it: from the
    // card, else from the local map (continue watching, favorites, Back).
    this.work = normalizeWork(params.work) || lookupWork(this.title, this.year);
    this.cardBackdrop = String(params.backdrop || "");
    this.workDetails = null;
    this.episodeMeta = null;      // Map index -> { still, title } for currentSource
    this._episodeMetaFor = "";    // probe key of the source the meta belongs to
    if (this.work && params.work) rememberWork(this.title, this.year, this.work);

    this._renderSkeleton();
    // Landscape hero: lay the page out for it from the first frame instead
    // of showing the poster and switching once the still is known.
    if (this._wantsBackdrop()) this._startBackdrop(epoch);
    this._renderHeroMeta(); // year from entry params; enriched as sources/detail arrive
    ScreenUtils.show(this.container);
    this._loadWorkDetails(epoch);

    if (this.mode === "single") {
      // Already have a source; optionally fetch detail for richer metadata.
      this._renderHeroMeta();
      this._maybeFetchDetail();
      this._fetchRelatedTitles();
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

    // Fast path: returning to a detail we already searched — restore the
    // session, no re-search, no re-probe, no auto-play.
    const session = getPreferSession(this.title, this.year);
    if (fromHistory && session) {
      this._restoreFromCache(session);
      return;
    }

    this.preferSession = startPreferSession(this.title, this.year);
    this.probeResults = this.preferSession.probeResults;

    // Focus the primary action from the start: play is never disabled, and
    // pressing it mid-probe plays the best source measured so far.
    ScreenUtils.setInitialFocus(this.container.querySelector('.btn[data-action="play"]'));
    await this._searchAndPrefer();
    this._saveCache();
  },

  // Provider metadata, fetched alongside the source search. Fire and forget:
  // a slow or failing provider never holds back sources or playback.
  async _loadWorkDetails(epoch) {
    if (!this.work) return;
    const details = await getWorkDetails(this.work);
    if (epoch !== this._mountEpoch || !details) return;
    this.workDetails = details;
    if (!this.poster && details.poster) this._setPoster(details.poster);
    this._renderHeroMeta();
    this._ensureEpisodeMeta();
  },

  // Landscape hero (settings → 详情页大图 → 横版剧照): the work's still
  // fills the whole screen behind the page — a 16:9 TV shows the frame
  // uncropped — the info sits on its shaded left, the poster steps aside.
  // Scrolling down to the episodes / sources deepens the shade.
  //
  // Only providers that can have a landscape still take this layout up
  // front (TMDB, douban); Bangumi has none and keeps the poster. The still
  // comes from the card when it has one (TMDB lists carry it), else from
  // the provider (douban photo wall, requested now, in parallel with the
  // details; TMDB details). It fades in when loaded. A work that turns out
  // to have none falls back to the poster.
  _wantsBackdrop() {
    return getHeroStyle() === "backdrop"
      && Boolean(this.work)
      && (this.work.provider === "tmdb" || this.work.provider === "douban");
  },

  async _startBackdrop(epoch) {
    const wrap = this.container?.querySelector("#detailBackdrop");
    const hero = this.container?.querySelector("#detailHero");
    const scroll = this.container?.querySelector("#detailScroll");
    if (!wrap || !hero) return;
    wrap.innerHTML = `<div class="detail-backdrop-shade"></div>`;
    wrap.classList.add("on");
    hero.classList.add("has-backdrop");
    scroll?.addEventListener("scroll", () => {
      wrap.classList.toggle("scrolled", scroll.scrollTop > 120);
    }, { passive: true });

    let url = this.cardBackdrop;
    if (!url) {
      const details = this.work.provider === "tmdb" ? await getWorkDetails(this.work) : null;
      url = await getWorkBackdrop(this.work, details);
    }
    if (epoch !== this._mountEpoch) return;
    if (!url) {
      wrap.classList.remove("on");
      wrap.innerHTML = "";
      hero.classList.remove("has-backdrop");
      return;
    }
    wrap.insertAdjacentHTML("afterbegin", `<img class="detail-backdrop-img" ${posterAttrs(url)} alt="" />`);
    hydratePosters(wrap);
  },

  // Episode stills / official titles for the playing source, from the work's
  // provider (TMDB tv, Bangumi). Re-requested when the source changes, since
  // sources may list different seasons. Until (unless) it lands, the text
  // buttons stay.
  async _ensureEpisodeMeta() {
    const src = this.currentSource;
    if (!this.work || !this.workDetails || !src || !Array.isArray(src.episodes) || src.episodes.length <= 1) return;
    const forKey = getSourceProbeKey(src);
    if (this._episodeMetaFor === forKey) return;
    this._episodeMetaFor = forKey;
    this.episodeMeta = null;
    const epoch = this._mountEpoch;
    const meta = await loadEpisodeMeta(this.work, this.workDetails, src);
    if (epoch !== this._mountEpoch || this._episodeMetaFor !== forKey || !meta.size) return;
    this.episodeMeta = meta;
    this._renderEpisodes();
  },

  // The probe Map is the session's own (written in place), so only the
  // source list and the pick need recording. Once playback started (or the
  // page was left) the pick belongs to the player: a background round's
  // late reselect must not overwrite the source actually being played.
  _saveCache() {
    const session = this.preferSession;
    if (this.mode !== "prefer" || !session || !this.sources.length) return;
    session.sources = this.sources;
    if (!this.preferCancelled) {
      session.currentSourceKey = this.currentSource ? getSourceProbeKey(this.currentSource) : "";
    }
  },

  // The pick is the session's current source: the one the player last
  // played, when the user switched or it failed over.
  _restoreFromCache(session) {
    this.preferSession = session;
    this.sources = session.sources;
    this.probeResults = session.probeResults;
    this.currentSource = this.sources.find(
      (s) => getSourceProbeKey(s) === session.currentSourceKey
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
    // Related badges ride the cached sources, not a fresh search.
    this._fetchRelatedTitles();
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
      <div class="detail-backdrop" id="detailBackdrop"></div>
      <div class="content-scroll" id="detailScroll">
        <div class="detail-hero" id="detailHero">
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
    if (!btn || this.noSources) return;
    const record = this._playRecord();
    let label = "播放";
    if (record && (Number(record.play_time) > 0 || Number(record.index) > 1)) {
      const src = this.currentSource || this.sources?.find((s) => s.id === String(record.id) && s.source === record.source);
      const isVersions = hasVersionLabels(src);
      if (Number(record.total_episodes) > 1) {
        const epTag = isVersions && src
          ? episodeLabel(src, Number(record.index) - 1)
          : `第 ${record.index} 集`;
        label = `继续播放 ${epTag}`;
      } else {
        label = "继续播放";
      }
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

    const work = this.workDetails || null;
    const year = String(work?.year || detail?.year || src?.year || this.year || "").trim();
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
      // Provider genres replace the source site's class; the rating names its
      // source ("豆瓣 7.3") so a TMDB or Bangumi score is never mistaken for
      // a douban one.
      const genres = work?.genres?.length ? work.genres.join(" / ") : "";
      const votes = formatVotes(work?.rating?.votes);
      const ratingLabel = work?.rating
        ? `${work.rating.source} ${work.rating.value}${votes ? `（${votes}）` : ""}`
        : "";
      const parts = [
        ratingLabel,
        year,
        typeLabel,
        genres || (className && className !== typeLabel ? className : ""),
        work?.duration && !(epCount > 1) ? work.duration : "",
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
      const text = String(work?.summary || detail?.desc || src?.desc || "").trim();
      desc.textContent = text;
      desc.style.display = text ? "" : "none";
    }

    const cast = this.container.querySelector("#detailCast");
    if (cast) {
      const lines = [];
      const director = (work?.directors?.length ? work.directors.join(" / ") : "") || detail?.director || src?.director;
      const actor = (work?.cast?.length ? work.cast.slice(0, 6).join(" / ") : "") || detail?.actor || src?.actor;
      const remarks = detail?.remarks || src?.remarks;
      if (director) lines.push(`导演：${escapeHtml(String(director))}`);
      if (actor) lines.push(`主演：${escapeHtml(String(actor))}`);
      if (remarks) lines.push(escapeHtml(String(remarks)));
      cast.innerHTML = lines.join("<br>");
      cast.style.display = lines.length ? "" : "none";
    }
  },

  // Related-series badges: search the series' base title once (see
  // relatedTitles.js — season marker dropped, part before the first space)
  // and render every distinct listing that starts with it, minus the work on
  // screen, as a jump badge. No heuristic guessing — the server returns only
  // titles that actually have playable sources.
  _relatedResults: [],
  _relatedKeyword: "",   // dedup guard: keyword already searched this mount

  // Driven explicitly from the four lifecycle sites that know whether a main
  // /api/search is coming (see _searchAndShare, single-source enter, restore
  // from cache, and probe continuation). It must NOT hang off _renderHeroMeta:
  // the first hero render fires before the prefer engine dispatches its search,
  // which used to cause a second identical request for bare titles.
  _fetchRelatedTitles() {
    const wrap = this.container?.querySelector("#detailRelated");
    const badgesEl = this.container?.querySelector("#detailRelatedBadges");
    if (!wrap || !badgesEl) return;
    // The keyword comes from the title the page was opened with, not from
    // whichever source is current: a source may spell the season without
    // the space, and the keyword then changed between the first visit and
    // Back from the player (badges appearing, then vanishing).
    const keyword = relatedKeyword(this.title || this.currentSource?.title || this.currentSource?.search_title);
    if (!keyword) { wrap.style.display = "none"; return; }

    // Dedup within a single mount: several lifecycle sites may reach this,
    // so the keyword is only dispatched once per mount.
    if (this._relatedKeyword === keyword) return;
    this._relatedKeyword = keyword;

    // Cache hit → render immediately, no network request. The cache is keyed
    // by keyword, so the same keyword never fetches twice across visits.
    const cached = getCachedRelated(keyword);
    if (cached?.length) {
      this._renderRelatedBadges(cached, wrap, badgesEl);
      return;
    }

    // A title with no season marker and no space is its own keyword, so the
    // main source search used it this mount — reuse its raw response instead
    // of issuing a second identical /api/search.
    if (this._lastSearchKeyword === keyword && this._lastSearchData) {
      this._storeAndRenderRelated(keyword, filterRelatedResults(this._lastSearchData, keyword), wrap, badgesEl);
      return;
    }

    const epoch = this._mountEpoch;
    api.searchVideos(keyword).then((data) => {
      if (epoch !== this._mountEpoch) return; // stale — user navigated away
      this._storeAndRenderRelated(keyword, filterRelatedResults(data, keyword), wrap, badgesEl);
    }).catch(() => {
      if (epoch !== this._mountEpoch) return;
      wrap.style.display = "none";
    });
  },

  // The aggregated server search answers differently from call to call; an
  // empty answer is not cached, or one bad search would hide the badges for
  // the cache's whole 24 h.
  _storeAndRenderRelated(keyword, related, wrap, badgesEl) {
    if (related.length) setCachedRelated(keyword, related);
    this._renderRelatedBadges(related, wrap, badgesEl);
  },

  _renderRelatedBadges(related, wrap, badgesEl) {
    const filtered = excludeRelated(related, [this.title, this.currentSource?.title, this.currentSource?.search_title]);
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
    this.searching = true;
    try {
      await this._runPreferEngine();
    } catch (e) {
      this._setStatus(`搜索失败：${escapeHtml(e?.message || e)}`);
    } finally {
      this.searching = false;
    }
  },

  // No resource site carries this work. That is a dead end, not a load
  // failure: say so, take away the actions that cannot do anything (play,
  // re-measure) and put the way out — back — where focus lands.
  _showNoSources() {
    this.noSources = true;
    this._setStatus("没有找到可播放的资源");
    const list = this.container.querySelector("#sourceList");
    if (list) list.innerHTML = `<div class="empty-state">资源站中没有「${escapeHtml(this.title)}」</div>`;
    const refresh = this.container.querySelector('.btn[data-action="refresh"]');
    if (refresh) refresh.remove();
    const play = this.container.querySelector('.btn[data-action="play"]');
    if (!play) return;
    const wasFocused = play.classList.contains("focused");
    play.dataset.action = "back";
    play.textContent = "返回";
    const focusedNow = this.container.querySelector(".focused");
    if (Router.current === "detail" && (wasFocused || !focusedNow)) {
      ScreenUtils.setFocus(play, this.container);
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
    // Probe-continuation mounts have no fresh source search; the related
    // badges render from their own cache (or a single request if uncached).
    this._fetchRelatedTitles();
  },

  // Fetch the raw /api/search response AND keep a copy for the related-series
  // badges. One search must serve both consumers when the keywords match, so
  // bare titles do not fire two identical requests per detail page.
  _searchAndShare(title) {
    this._lastSearchKeyword = title;
    return api.searchVideos(title).then((data) => {
      this._lastSearchData = data;
      // Main search response now serves both consumers when the related
      // keyword matches (bare titles) — render the badges from it without a
      // second request. Dedup guard inside _fetchRelatedTitles makes repeated
      // calls from other lifecycle sites a no-op.
      this._fetchRelatedTitles();
      return data;
    });
  },

  async _runPreferEngine({
    reselect = true,
    initialSources = null,
    existingProbeResults = this.probeResults,
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
      searchVideos: (title) => this._searchAndShare(title),
      probePlayback: (...args) => api.probePlayback(...args),
      // Real coded resolution from the bitstream, read by the on-device
      // service. Returns null without the service (dev preview, non-webOS),
      // and then every source keeps ranking on its upstream label.
      measureResolution: (url, signal) => readStreamResolution(url, { signal }),
      // A round still running when playback starts finishes on fewer
      // workers instead of competing with the stream at full width.
      concurrency: () => (Router.current === "player" ? PREFER_PLAYBACK_CONCURRENCY : PREFER_CONCURRENCY),
      isStale: () => epoch !== this._mountEpoch,
      canAutoPlay: () => !this.preferCancelled,
      onSources: ({ sources, probeResults }) => {
        this.sources = sources;
        this.probeResults = probeResults;
        this.probeRunning = Boolean(sources.length);
        this.probeTotal = sources.length;
        this.probeDone = Array.from(probeResults.keys()).length;
        if (!sources.length) {
          this._showNoSources();
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
      // Playback evidence from the player, kept apart from the probe metrics.
      const playFailed = this.preferSession?.failedSourceKeys.has(key)
        ? ` · <span class="probe-failed" data-play-failed>播放失败</span>`
        : "";
      return `
        <div class="source-row${isCurrent ? " current" : ""} focusable" data-action="switch-source" data-key="${escapeHtml(key)}">
          <div class="source-row-name">${escapeHtml(src.source_name || src.source)}</div>
          <div class="source-row-meta">${epCount} 集${playFailed}</div>
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
    const src = this.currentSource;
    const record = this._playRecord();
    const resumeIdx = record && Number(record.index) >= 1
      ? Math.min(Number(record.index) - 1, eps.length - 1)
      : -1;
    head.style.display = "flex";
    const hint = this.container.querySelector("#episodesHint");
    if (hint) {
      hint.textContent = `共 ${eps.length} 集${resumeIdx >= 0 ? ` · 上次看到第 ${resumeIdx + 1} 集` : ""}`;
    }
    // Re-rendering replaces the nodes; keep the focused episode focused.
    const focusedEp = list.querySelector(".focused");
    const focusedIndex = focusedEp ? Number(focusedEp.dataset.index) : -1;
    const meta = this._episodeMetaFor === getSourceProbeKey(src) ? this.episodeMeta : null;
    if (meta?.size) {
      list.classList.add("stills");
      list.style.display = "flex";
      // A provider without artwork (Bangumi) gets title cards with no image
      // area; with artwork, an episode lacking a still keeps a blank face so
      // the rail stays aligned.
      const anyStill = [...meta.values()].some((m) => m.still);
      list.innerHTML = eps.map((_, i) => {
        const m = meta.get(i) || { still: "", title: "" };
        const still = !anyStill ? ""
          : m.still
            ? `<img class="episode-still" ${posterAttrs(m.still)} alt="" />`
            : `<div class="episode-still blank"></div>`;
        const title = m.title ? `<span class="episode-card-title">${escapeHtml(m.title)}</span>` : "";
        return `
          <div class="episode-card${i === resumeIdx ? " resume" : ""} focusable" data-action="play-ep" data-index="${i}">
            ${still}
            <div class="episode-card-label"><span class="episode-card-no">${escapeHtml(episodeLabel(src, i))}</span>${title}</div>
          </div>`;
      }).join("");
      hydratePosters(list);
    } else {
      list.classList.remove("stills");
      list.style.display = "grid";
      list.innerHTML = eps.map((_, i) => `
      <div class="episode-item${i === resumeIdx ? " resume" : ""} focusable" data-action="play-ep" data-index="${i}">${escapeHtml(episodeLabel(src, i))}</div>
    `).join("");
    }
    ScreenUtils.indexFocusables(list, ".focusable");
    if (focusedIndex >= 0) {
      const again = list.querySelector(`[data-index="${focusedIndex}"]`);
      if (again) ScreenUtils.setFocus(again, this.container);
    }
    this._ensureEpisodeMeta();
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
    if (this.preferSession) this.preferSession.currentSourceKey = getSourceProbeKey(source);
    // Continue watching reopens by the source's title; keep the work under it.
    if (this.work) rememberWork(source.title || source.search_title, source.year, this.work);

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
        total_episodes: source.episodes.length,
        episodes_titles: Array.isArray(source.episodes_titles) ? source.episodes_titles : []
      },
      // Pass through all sources + the live probe Map so the player can
      // offer source switching with the same ranking, including probes that
      // finish after it opens. The session carries the player's switches and
      // playback failures back to this page.
      allSources: this.sources,
      probeResults: this.probeResults,
      preferSession: this.preferSession,
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
        if (!src) {
          showToast(this.searching ? "正在搜索播放源…" : "没有找到可播放的资源");
          return;
        }
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
      if (action === "back") { await Router.back(); return; }
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
        if (!this.sources.length) { showToast("没有可测速的播放源"); return; }
        if (this.probeRunning) { showToast("测速进行中"); return; }
        this.probeResults.clear(); // in place: the session shares this Map
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
    if (this.work) rememberWork(favorite.search_title, favorite.year, this.work);
    LibrarySync.pushFavorite(key, favorite);
    this._updateFavoriteButton();
    showToast("已收藏");
  },

  cleanup() {
    this.preferCancelled = true;
    ScreenUtils.hide(this.container);
  }
};
