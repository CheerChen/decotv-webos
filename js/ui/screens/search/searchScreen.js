// searchScreen.js — category browse screen for movie / tv / anime / show / documentary.
// TV-first: pure D-pad navigation through category chips, no text input.
//
// Two endpoint families:
//   recent_hot  — Douban "recent hot" charts (sub-charts by category+type).
//   recommend   — Douban recommendation pool with multi-dimensional filters
//                 (category + region + year + sort), orthogonal combination.
//
// Tab structure (11 content tabs):
//   热门电影/剧集/动漫/综艺 → recent_hot chart browsing
//   电影/剧集/动漫/综艺     → recommend multi-filter (default sort=S, classic/high-rated)
//   纪录片                  → mixed: default recent_hot, "精选筛选" mode → recommend
//
// Large result sets auto-load downward: when focus approaches the end of
// the grid (and the set qualifies as large — see LARGE_RESULT_MIN), up to
// MAX_AUTO_LOADS extra pages are fetched and appended in place.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { tmdb } from "../../../core/network/tmdbClient.js";
import { getProvider, setProvider } from "../../../core/storage/catalogProvider.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { posterAttrs } from "../../posterImage.js";
import { escapeHtml } from "../../utils.js";
import { showToast } from "../../toast.js";
import { TYPE_CONFIGS, WEEKDAYS, todayWeekday, bangumiToCards } from "./browseConfig.js";

// Page size for category browse. 20 on BOTH providers: TMDB v3 hard-caps
// every page at 20, so Douban matches it to keep provider behaviour
// identical (same page math, same short-page "end of data" signal).
// With auto-load-down this yields up to 20x5 = 100 items per category.
const PAGE_SIZE = 20;

// Auto-load-down for large category result sets.
// "Large": TMDB responses carry `total` — a result set of >= 100 items with
// more pages left qualifies. Douban responses carry no total, so a completely
// full first page (20/20) is the practical signal — narrow filters (e.g.
// 2026 + 日本) come back short and never qualify.
// When qualified, scrolling focus into the last ~2 rows fetches the next
// page, up to MAX_AUTO_LOADS times (20x5 = 100 items on either provider).
// A short page or a failed fetch ends the chain early.
const LARGE_RESULT_MIN = 100;
const MAX_AUTO_LOADS = 4;
const AUTO_LOAD_TRIGGER_LEFT = 16; // ~2 grid rows on a 1920px screen

// In-memory snapshots keyed by tab type. Only needed across one Back
// navigation (detail → search), so a module-level Map is enough — no
// localStorage, no TTL, no cross-restart persistence. Mirrors the
// detailScreen prefer-cache pattern but lighter: filter state is cheap to
// rebuild and meaningless after an app restart.
const SNAPSHOTS = new Map();

export const SearchScreen = {
  container: null,
  results: [],
  loading: false,
  type: "hot-movie",
  // Unified filter state: { filterId: selectedValue }.
  filterValues: {},
  selectedWeekday: null,
  abortCtrl: null,
  // Auto-load-down state (see constants above). loadToken guards against
  // a category change racing an in-flight auto-load append.
  autoLoads: 0,
  autoLoadTotal: null,
  autoLoadDone: false,
  autoLoading: false,
  tmdbNextPage: 1,
  loadToken: 0,

  async mount(params = {}, opts = {}) {
    this.container = document.getElementById("search");
    this.provider = getProvider();
    const fromHistory = Boolean(opts?.fromHistory);
    const restoreType = params.type || this.type || "hot-movie";
    const snapshot = fromHistory ? SNAPSHOTS.get(restoreType) : null;

    this.type = restoreType;
    // Digit shortcuts request first-cover focus; tab clicks leave the default
    // (filter chip) so D-pad filter browsing is unchanged.
    this.focusFirstItem = Boolean(params.focusFirstItem);

    if (snapshot) {
      // Restore the exact filter/list/scroll/focus the user had before
      // navigating to detail. No re-fetch — the category chart is unlikely
      // to have changed in the seconds since they left.
      this.results = snapshot.results;
      this.filterValues = { ...snapshot.filterValues };
      this.selectedWeekday = snapshot.selectedWeekday;
      this.abortCtrl = null;
      // Auto-load bookkeeping: pages already loaded are implied by the list
      // length; total is unknown after restore so Douban-style eligibility
      // (list >= PAGE_SIZE) applies until the next full reload.
      this.autoLoads = Math.min(
        MAX_AUTO_LOADS,
        Math.ceil(Math.max(0, this.results.length - PAGE_SIZE) / PAGE_SIZE)
      );
      this.autoLoadTotal = null;
      this.autoLoadDone = this.autoLoads >= MAX_AUTO_LOADS;
      this.autoLoading = false;
      this.tmdbNextPage = 1;
      this.loadToken += 1;
      const activeTab = `nav-${this.type}`;
      this.container.innerHTML = `
        ${renderNavHeader(activeTab)}
        <div class="content-scroll" id="searchScroll">
          <div id="searchFilters"></div>
          <div id="searchBody"></div>
        </div>
      `;
      ScreenUtils.show(this.container);
      bindNavClicks(this.container);
      this._renderFilters();
      this._renderResults();
      // Restore scroll + focus after the DOM is laid out.
      const scroll = this.container.querySelector("#searchScroll");
      if (scroll && snapshot.scrollTop) scroll.scrollTop = snapshot.scrollTop;
      if (snapshot.focusMarker) {
        const restored = Array.from(this.container.querySelectorAll(".focusable"))
          .find((n) => ScreenUtils.focusMarker(n) === snapshot.focusMarker);
        if (restored) ScreenUtils.setInitialFocus(restored);
      }
      return;
    }

    this.results = [];
    const cfg = TYPE_CONFIGS[this.type] || TYPE_CONFIGS["hot-movie"];
    const acfg = this._activeConfig(cfg);
    // Initialize filter values to defaults.
    this.filterValues = {};
    for (const f of acfg.filters) {
      this.filterValues[f.id] = f.default;
    }
    this.selectedWeekday = (this.provider === "douban" && this.type === "hot-anime") ? todayWeekday() : null;
    const activeTab = `nav-${this.type}`;
    this.container.innerHTML = `
      ${renderNavHeader(activeTab)}
      <div class="content-scroll" id="searchScroll">
        <div id="searchFilters"></div>
        <div id="searchBody"><div class="center-wrap"><div class="loading-spinner"></div></div></div>
      </div>
    `;
    ScreenUtils.show(this.container);
    bindNavClicks(this.container);
    this._renderFilters();
    this._loadCategory();
  },

  // ── Filter chips ──────────────────────────────────────────────────────────

  // Return the provider-specific config block for the current tab.
  // Douban fields live on the tab root; TMDB fields live under .tmdb.
  _activeConfig(cfg) {
    cfg = cfg || TYPE_CONFIGS[this.type] || TYPE_CONFIGS["hot-movie"];
    if (this.provider === "tmdb" && cfg.tmdb) return cfg.tmdb;
    return cfg;
  },

  _renderFilters() {
    const wrap = this.container.querySelector("#searchFilters");
    const cfg = TYPE_CONFIGS[this.type] || TYPE_CONFIGS["hot-movie"];
    const acfg = this._activeConfig(cfg);

    // Build chip rows from config filters.
    const rows = [];
    for (const f of acfg.filters) {
      // showWhen: only render this row when another filter has a specific value.
      if (f.showWhen && this.filterValues[f.showWhen.field || "mode"] !== f.showWhen.value) {
        // Legacy: showWhen is a string shorthand for { field: "mode", value: <string> }.
        if (typeof f.showWhen === "string") {
          if (this.filterValues.mode !== f.showWhen) continue;
        } else {
          continue;
        }
      }
      const chips = f.options.map((opt) => {
        const active = opt.value === this.filterValues[f.id] ? " active" : "";
        return `<button class="btn chip focusable${active}" data-action="select-filter" data-filter="${escapeHtml(f.id)}" data-value="${escapeHtml(opt.value)}" data-label="${escapeHtml(opt.label)}">${opt.label}</button>`;
      }).join("");
      const scrollWrap = f.options.length > 8 ? `<div class="chip-scroll-inner">${chips}</div>` : chips;
      const scrollClass = f.options.length > 8 ? " chip-row-scroll" : "";
      rows.push(`<div class="chip-row${scrollClass}" id="row-${f.id}"><span class="chip-label">${f.label}</span>${scrollWrap}</div>`);
    }

    // Weekday row for hot-anime "每日放送" (Douban only — TMDB has no
    // airing calendar).
    let weekdayHtml = "";
    if (this.provider === "douban" && cfg.hasWeekday && this.filterValues.type === "每日放送") {
      weekdayHtml = `<div class="chip-row" id="weekdayRow"><span class="chip-label">星期</span>${
        WEEKDAYS.map((d) => {
          const active = d.value === this.selectedWeekday ? " active" : "";
          return `<button class="btn chip focusable${active}" data-action="select-weekday" data-value="${d.value}">${d.label}</button>`;
        }).join("")
      }</div>`;
    }

    wrap.innerHTML = rows.join("") + weekdayHtml;

    // Default focus: first active filter chip, or first chip. Skip when a
    // digit shortcut asked for the first cover — that focus is applied once
    // results render so we do not park the ring on a chip mid-load.
    if (!this.focusFirstItem) {
      const defaultFocus = wrap.querySelector('[data-action="select-filter"].active') || wrap.querySelector('[data-action="select-filter"]') || wrap.querySelector('[data-action="select-weekday"]');
      if (defaultFocus) ScreenUtils.setFocus(defaultFocus, this.container);
    }
    ScreenUtils.indexFocusables(wrap);
  },

  // ── Category loading ──────────────────────────────────────────────────────
  async _loadCategory() {
    if (this.abortCtrl) this.abortCtrl.abort();
    this.abortCtrl = new AbortController();
    this.loadToken += 1;
    this.autoLoads = 0;
    this.autoLoadTotal = null;
    this.autoLoadDone = false;
    this.autoLoading = false;
    this.loading = true;
    const body = this.container.querySelector("#searchBody");
    body.innerHTML = `<div class="center-wrap"><div class="loading-spinner"></div></div>`;
    try {
      this.results = await this._fetchCategory();
      this.loading = false;
      this._renderResults();
    } catch (e) {
      this.loading = false;
      if (e?.name === "AbortError") return;
      body.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e?.message || e)}</div>`;
    }
  },

  // ── Auto-load-down ────────────────────────────────────────────────────────

  _autoLoadEligible() {
    if (this.autoLoadDone || this.autoLoads >= MAX_AUTO_LOADS) return false;
    if (this.provider === "tmdb" && this.autoLoadTotal != null) {
      return this.autoLoadTotal >= LARGE_RESULT_MIN
        && this.results.length < this.autoLoadTotal;
    }
    // Douban (or restored snapshot): a full page means there is very likely
    // more behind it — try one load and let a short page end the chain.
    return this.results.length >= PAGE_SIZE;
  },

  // Fire-and-forget trigger, called on focus moves inside the result grid.
  _maybeAutoLoad(focused) {
    const card = focused?.closest?.(".poster-card");
    if (!card) return;
    const idx = Number(card.dataset.index || 0);
    if (idx < this.results.length - AUTO_LOAD_TRIGGER_LEFT) return;
    if (!this._autoLoadEligible() || this.autoLoading || this.loading) return;
    this._autoLoadMore();
  },

  async _autoLoadMore() {
    const token = this.loadToken;
    this.autoLoading = true;
    const start = this.results.length;
    const page = this.tmdbNextPage > 1 ? this.tmdbNextPage : Math.floor(start / PAGE_SIZE) + 2;
    try {
      const more = await this._fetchCategory({ start, page });
      if (token !== this.loadToken) return; // category changed mid-flight
      if (!Array.isArray(more) || !more.length) {
        this.autoLoadDone = true;
        return;
      }
      this.results = this.results.concat(more);
      this.autoLoads += 1;
      if (more.length < PAGE_SIZE) this.autoLoadDone = true; // end of data
      if (this.autoLoadTotal != null && this.results.length >= this.autoLoadTotal) {
        this.autoLoadDone = true;
      }
      this._appendCards(more, start);
    } catch (e) {
      if (e?.name === "AbortError") return;
      this.autoLoadDone = true; // network hiccup — stop the chain, keep what we have
    } finally {
      if (token === this.loadToken) this.autoLoading = false;
    }
  },

  // Append new cards without rebuilding the grid — keeps scroll position,
  // focus node and already-loaded poster images untouched.
  _appendCards(items, from) {
    const grid = this.container.querySelector(".poster-grid");
    if (!grid) return;
    grid.insertAdjacentHTML("beforeend", items.map((r, j) => this._cardHtml(r, from + j)).join(""));
    ScreenUtils.indexFocusables(grid);
  },

  // Dispatch to the correct API based on provider + endpoint type + filter values.
  // `paging`: { start } for Douban offset APIs, { page } for TMDB pages.
  async _fetchCategory(paging = {}) {
    const start = paging.start || 0;
    const page = paging.page || 1;
    const cfg = TYPE_CONFIGS[this.type];
    const fv = this.filterValues;

    // ── TMDB provider ──
    if (this.provider === "tmdb" && cfg.tmdb) {
      try {
        const list = await this._fetchTmdb(cfg.tmdb, fv, page);
        this.tmdbNextPage = page + 1;
        this.autoLoadTotal = Number.isFinite(this._tmdbTotal) ? this._tmdbTotal : null;
        return list;
      } catch (e) {
        // TMDB sidecar unreachable (not deployed / bad URL / key error).
        // Auto-fallback to Douban so an upgraded client without the sidecar
        // still browses instead of showing a dead error. One-shot: provider
        // is now douban, so this branch won't fire again this session.
        if (e?.name === "AbortError") throw e;
        setProvider("douban");
        this.provider = "douban";
        showToast("TMDB 服务不可用，已切换回豆瓣");
        return this._fetchCategory(paging);
      }
    }

    // ── mixed-anime (hot-anime): 全部/每日放送 → recent_hot, 国家 → recommend ──
    if (cfg.endpoint === "mixed-anime") {
      const t = fv.type;
      // Bangumi special case for "每日放送".
      if (t === "每日放送") {
        const calendar = await api.getBangumiCalendar();
        return bangumiToCards(calendar, this.selectedWeekday);
      }
      // "全部" → recent_hot anime chart.
      if (t === "tv_animation") {
        const data = await api.getDoubanCategories("tv", "tv", "tv_animation", PAGE_SIZE, start);
        return Array.isArray(data?.list) ? data.list : [];
      }
      // Country filter (华语/日本/欧美) → recommend category=动画, sort=U (近期热度).
      const data = await api.getDoubanRecommends("tv", {
        category: "动画", format: "电视剧", region: t, sort: "U", limit: PAGE_SIZE, start,
      });
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── recent_hot ──
    if (cfg.endpoint === "recent_hot") {
      // Bangumi special case for hot-anime "每日放送".
      if (cfg.hasWeekday && fv.type === "每日放送") {
        const calendar = await api.getBangumiCalendar();
        return bangumiToCards(calendar, this.selectedWeekday);
      }
      const kind = cfg.rhKind;
      const category = cfg.rhCategory || fv.category;
      const type = fv.type;
      const data = await api.getDoubanCategories(kind, category, type, PAGE_SIZE, start);
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── recommend ──
    if (cfg.endpoint === "recommend") {
      const data = await api.getDoubanRecommends(cfg.recKind, {
        category: cfg.recCategory || fv.category || "",
        format: cfg.recFormat || "",
        region: fv.region || "",
        year: fv.year || "",
        sort: fv.sort || "",
        limit: PAGE_SIZE,
        start,
      });
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── mixed (documentary) ──
    if (cfg.endpoint === "mixed") {
      if (fv.mode === "hot") {
        const data = await api.getDoubanCategories("tv", "tv", "tv_documentary", PAGE_SIZE, start);
        return Array.isArray(data?.list) ? data.list : [];
      }
      // curated → recommend
      const data = await api.getDoubanRecommends("tv", {
        format: "纪录片",
        region: fv.region || "",
        year: fv.year || "",
        sort: fv.sort || "",
        limit: PAGE_SIZE,
        start,
      });
      return Array.isArray(data?.list) ? data.list : [];
    }

    return [];
  },

  // TMDB provider: route to sidecar chart or discover endpoint.
  // `tcfg` is the cfg.tmdb block (endpoint, mediaType, genrePreset, ...).
  async _fetchTmdb(tcfg, fv, page) {
    const mediaType = tcfg.mediaType || "movie";
    if (tcfg.endpoint === "chart") {
      const chart = fv.chart || "hot";
      const data = await tmdb.getChart(mediaType, chart, page);
      return this._normalizeTmdbList(data);
    }
    if (tcfg.endpoint === "discover") {
      // Documentary "hot" mode: discover with genrePreset + popularity sort,
      // ignoring the user's sort/region/year chips (they are hidden by
      // showWhen). "curated" mode: pass through all filters.
      const genre = tcfg.genrePreset || fv.genre || "";
      const sort = (fv.mode === "hot" && !fv.sort) ? "popularity" : (fv.sort || "popularity");
      // Anime tab: 地区=全部 means Japanese animation (defaultLanguage), a
      // picked region (日本/欧美/华语) maps to that country's language.
      const region = fv.region || "";
      const language = (!region && tcfg.defaultLanguage) ? tcfg.defaultLanguage : "";
      const data = await tmdb.getDiscover({
        mediaType,
        genre,
        region,
        language,
        year: fv.year || "",
        sort,
        page,
        // 剧集 tab excludes animation (genre 16) — see browseConfig.
        exclude_genres: tcfg.excludeGenres || "",
        // 综艺/纪录片 collapse franchise repeats (Paradise Hotel x3).
        dedupe: tcfg.dedupe ? "1" : "",
      });
      return this._normalizeTmdbList(data);
    }
    return [];
  },

  // TMDB sidecar returns {list:[{id,title,poster,rate,year}]} where poster
  // is a full image.tmdb.org URL. Wrap it through the sidecar image proxy
  // so posterImage.js routes it via lunaSidecarFetchImage. Also captures
  // `total` for the auto-load eligibility check.
  _normalizeTmdbList(data) {
    const list = Array.isArray(data?.list) ? data.list : [];
    this._tmdbTotal = Number.isFinite(data?.total) ? data.total : null;
    return list.map((item) => ({
      ...item,
      poster: tmdb.getImageUrl(item.poster) || item.poster,
    }));
  },

  _cardHtml(r, i) {
    const poster = posterAttrs(r.poster);
    const title = escapeHtml(r.title || r.name_cn || r.name || "");
    const year = escapeHtml(r.year || "");
    const rate = r.rate ? `<span class="rate-badge">★ ${escapeHtml(r.rate)}</span>` : "";
    const sub = `${rate}${year ? `<span>${year}</span>` : ""}`;
    return `
      <div class="poster-card focusable" data-action="open-douban" data-index="${i}">
        <img class="poster-img" ${poster} alt="" loading="lazy" onerror="this.style.opacity=0.1" />
        <div class="poster-meta">
          <div class="poster-title">${title}</div>
          <div class="poster-sub">${sub}</div>
        </div>
      </div>
    `;
  },

  _renderResults() {
    const body = this.container.querySelector("#searchBody");
    if (!this.results.length) {
      body.innerHTML = `<div class="empty-state">暂无内容</div>`;
      // No covers — fall back to the filter chip so the screen is still
      // navigable after a digit shortcut lands on an empty category.
      if (this.focusFirstItem) {
        this.focusFirstItem = false;
        const chip = this.container.querySelector('[data-action="select-filter"].active')
          || this.container.querySelector('[data-action="select-filter"]');
        if (chip) ScreenUtils.setInitialFocus(chip);
      }
      return;
    }
    const cards = this.results.slice(0, 120).map((r, i) => this._cardHtml(r, i)).join("");
    const cfg = TYPE_CONFIGS[this.type];
    const heading = `${cfg.label} · ${escapeHtml(this._currentTagLabel())}`;
    body.innerHTML = `<div class="section-title">${heading}</div><div class="poster-grid">${cards}</div>`;
    ScreenUtils.indexFocusables(body);
    if (this.focusFirstItem) {
      this.focusFirstItem = false;
      const first = body.querySelector(".poster-card");
      if (first) ScreenUtils.setInitialFocus(first);
    }
  },

  // Build heading suffix from active filter labels.
  _currentTagLabel() {
    const cfg = TYPE_CONFIGS[this.type];
    const acfg = this._activeConfig(cfg);
    const parts = [];
    for (const f of acfg.filters) {
      // Skip filters that are not visible (showWhen not met).
      if (f.showWhen) {
        const showVal = typeof f.showWhen === "string" ? f.showWhen : f.showWhen.value;
        if (this.filterValues.mode !== showVal) continue;
      }
      const opt = f.options.find((o) => o.value === this.filterValues[f.id]);
      const label = opt?.label || this.filterValues[f.id];
      // Skip "全部" in heading to keep it concise — except for single-filter tabs.
      if (label === "全部" && acfg.filters.length > 1) continue;
      parts.push(label);
    }
    // Add weekday for hot-anime 每日放送 (Douban only).
    if (this.provider === "douban" && cfg.hasWeekday && this.filterValues.type === "每日放送") {
      const wd = WEEKDAYS.find((d) => d.value === this.selectedWeekday);
      parts.push(wd?.label || this.selectedWeekday);
    }
    return parts.join(" · ") || "全部";
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    const focused = this.container.querySelector(".focused");

    if (ScreenUtils.handleDpadNavigation(event, this.container)) {
      // Focus moved — the auto-load-down trigger rides along so no extra
      // key handling is needed to grow large result sets.
      this._maybeAutoLoad(this.container.querySelector(".focused"));
      return;
    }

    if (code === 13) {
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "select-filter") {
        const filterId = focused.dataset.filter;
        this.filterValues[filterId] = focused.dataset.value;
        // Reset weekday when switching to/from 每日放送 in hot-anime.
        if (this.type === "hot-anime") this.selectedWeekday = todayWeekday();
        this._renderFilters();
        this._loadCategory();
        return;
      }
      if (action === "select-weekday") {
        this.selectedWeekday = focused.dataset.value;
        this._renderFilters();
        this._loadCategory();
        return;
      }
      if (action === "open-douban") {
        const idx = Number(focused.dataset.index);
        const r = this.results[idx];
        if (!r) return;
        Router.navigate("detail", { title: r.title, poster: r.poster, year: r.year, autoPlay: true });
        return;
      }
      // Nav tabs — handleNavAction covers all nav-* dispatching.
      if (handleNavAction(action)) return;
    }
  },

  cleanup() {
    // Snapshot the live state so a Back from detail restores the exact
    // filters / list / scroll / focus the user had. Only worth saving when
    // we actually have results — an aborted load or empty screen has nothing
    // to restore and would just mask the fresh default-load path.
    if (this.type && this.results.length) {
      const scroll = this.container?.querySelector("#searchScroll");
      const focused = this.container?.querySelector(".focused");
      SNAPSHOTS.set(this.type, {
        results: this.results,
        filterValues: { ...this.filterValues },
        selectedWeekday: this.selectedWeekday,
        scrollTop: scroll?.scrollTop || 0,
        focusMarker: focused ? ScreenUtils.focusMarker(focused) : "",
      });
    }
    if (this.abortCtrl) this.abortCtrl.abort();
    ScreenUtils.hide(this.container);
  }
};
