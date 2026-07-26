// searchScreen.js — category browse screen for movie / tv / anime / show.
// TV-first: pure D-pad navigation through category chips, no text input.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";

const PAGE_SIZE = 24;

// Second-level filters for anime 番剧/剧场版 (recommends API only).
const YEAR_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "2026", value: "2026" },
  { label: "2025", value: "2025" },
  { label: "2024", value: "2024" },
  { label: "2023", value: "2023" },
  { label: "2022", value: "2022" },
  { label: "2021", value: "2021" },
  { label: "2020", value: "2020" },
  { label: "2010年代", value: "2010s" },
  { label: "2000年代", value: "2000s" },
  { label: "90年代", value: "1990s" },
  { label: "80年代", value: "1980s" },
  { label: "更早", value: "earlier" },
];

const SORT_OPTIONS = [
  { label: "近期热度", value: "U" },
  { label: "综合排序", value: "T" },
  { label: "首播时间", value: "R" },
  { label: "高分优先", value: "S" },
];

// Per-type category config. Each type has its own set of tag chips and
// a loader function that knows which API to call for that tag.
const TYPE_CONFIGS = {
  movie: {
    label: "电影",
    tags: ["热门", "最新", "豆瓣高分", "冷门佳片", "华语", "欧美", "日本", "韩国", "喜剧", "爱情", "科幻", "悬疑", "动作", "动画", "纪录片"],
    defaultTag: "热门",
  },
  tv: {
    label: "剧集",
    // tv uses /api/douban/categories with type param; tag is the sub-category.
    tags: [
      { label: "最近热门", value: "tv" },
      { label: "国产", value: "tv_domestic" },
      { label: "欧美", value: "tv_american" },
      { label: "日本", value: "tv_japanese" },
      { label: "韩国", value: "tv_korean" },
      { label: "动漫", value: "tv_animation" },
      { label: "纪录片", value: "tv_documentary" },
    ],
    defaultTag: "tv",
  },
  show: {
    label: "综艺",
    tags: [
      { label: "最近热门", value: "show" },
      { label: "国内", value: "show_domestic" },
      { label: "国外", value: "show_foreign" },
    ],
    defaultTag: "show",
  },
  anime: {
    label: "动漫",
    tags: ["番剧", "剧场版", "每日放送"],
    defaultTag: "番剧",
  },
};

// Bangumi weekday labels for anime "每日放送".
const WEEKDAYS = [
  { value: "Mon", label: "周一" },
  { value: "Tue", label: "周二" },
  { value: "Wed", label: "周三" },
  { value: "Thu", label: "周四" },
  { value: "Fri", label: "周五" },
  { value: "Sat", label: "周六" },
  { value: "Sun", label: "周日" },
];

function todayWeekday() {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];
}

export const SearchScreen = {
  container: null,
  results: [],
  loading: false,
  type: "movie",
  selectedTag: null,
  selectedWeekday: null,
  selectedYear: "all",
  selectedSort: "U",
  abortCtrl: null,

  async mount(params = {}) {
    this.container = document.getElementById("search");
    this.results = [];
    this.type = params.type || "movie";
    const cfg = TYPE_CONFIGS[this.type] || TYPE_CONFIGS.movie;
    this.selectedTag = cfg.defaultTag;
    this.selectedWeekday = this.type === "anime" ? todayWeekday() : null;
    this.selectedYear = "all";
    this.selectedSort = "U";
    this.container.innerHTML = `
      <div class="app-header">
        <div class="brand">DecoTV</div>
        <div class="nav-tabs">
          <div class="nav-tab focusable" data-action="nav-home">首页</div>
          <div class="nav-tab focusable${this.type === "movie" ? " active" : ""}" data-action="nav-movie">电影</div>
          <div class="nav-tab focusable${this.type === "tv" ? " active" : ""}" data-action="nav-tv">剧集</div>
          <div class="nav-tab focusable${this.type === "anime" ? " active" : ""}" data-action="nav-anime">动漫</div>
          <div class="nav-tab focusable${this.type === "show" ? " active" : ""}" data-action="nav-show">综艺</div>
          <div class="nav-tab focusable" data-action="nav-library">收藏</div>
          <div class="nav-tab focusable" data-action="nav-settings">设置</div>
        </div>
      </div>
      <div class="content-scroll" id="searchScroll">
        <div id="searchFilters"></div>
        <div id="searchBody"><div class="center-wrap"><div class="loading-spinner"></div></div></div>
      </div>
    `;
    ScreenUtils.show(this.container);
    this._renderFilters();
    this._bindNav();
    this._loadCategory();
  },

  // ── Filter chips ──────────────────────────────────────────────────────────
  _renderFilters() {
    const wrap = this.container.querySelector("#searchFilters");
    const cfg = TYPE_CONFIGS[this.type] || TYPE_CONFIGS.movie;

    // Tag / sub-category chips.
    const tagChips = cfg.tags.map((tag) => {
      const label = typeof tag === "string" ? tag : tag.label;
      const value = typeof tag === "string" ? tag : tag.value;
      const active = value === this.selectedTag ? " active" : "";
      return `<button class="btn chip focusable${active}" data-action="select-tag" data-value="${this._escape(value)}" data-label="${this._escape(label)}">${label}</button>`;
    }).join("");

    // Weekday chips for anime "每日放送".
    let weekdayHtml = "";
    if (this.type === "anime" && this.selectedTag === "每日放送") {
      weekdayHtml = `<div class="chip-row" id="weekdayRow"><span class="chip-label">星期</span>${
        WEEKDAYS.map((d) => {
          const active = d.value === this.selectedWeekday ? " active" : "";
          return `<button class="btn chip focusable${active}" data-action="select-weekday" data-value="${d.value}">${d.label}</button>`;
        }).join("")
      }</div>`;
    }

    // Second-level filters (year + sort) for anime 番剧/剧场版 only.
    let subFilterHtml = "";
    if (this.type === "anime" && (this.selectedTag === "番剧" || this.selectedTag === "剧场版")) {
      const yearChips = YEAR_OPTIONS.map((y) => {
        const active = y.value === this.selectedYear ? " active" : "";
        return `<button class="btn chip focusable${active}" data-action="select-year" data-value="${y.value}">${y.label}</button>`;
      }).join("");
      const sortChips = SORT_OPTIONS.map((s) => {
        const active = s.value === this.selectedSort ? " active" : "";
        return `<button class="btn chip focusable${active}" data-action="select-sort" data-value="${s.value}">${s.label}</button>`;
      }).join("");
      subFilterHtml = `
        <div class="chip-row chip-row-scroll" id="yearRow"><span class="chip-label">年代</span><div class="chip-scroll-inner">${yearChips}</div></div>
        <div class="chip-row" id="sortRow"><span class="chip-label">排序</span>${sortChips}</div>
      `;
    }

    wrap.innerHTML = `
      <div class="chip-row" id="tagRow"><span class="chip-label">分类</span>${tagChips}</div>
      ${weekdayHtml}
      ${subFilterHtml}
    `;

    // Default focus: the active tag chip.
    const defaultFocus = wrap.querySelector('[data-action="select-tag"].active') || wrap.querySelector('[data-action="select-tag"]');
    if (defaultFocus) {
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      defaultFocus.classList.add("focused");
      defaultFocus.focus();
    }
    ScreenUtils.indexFocusables(wrap);
  },

  // ── Category loading ──────────────────────────────────────────────────────
  async _loadCategory() {
    if (this.abortCtrl) this.abortCtrl.abort();
    this.abortCtrl = new AbortController();
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
      body.innerHTML = `<div class="empty-state">加载失败：${this._escape(e?.message || e)}</div>`;
    }
  },

  // Dispatch to the correct API based on type + tag.
  async _fetchCategory() {
    const cfg = TYPE_CONFIGS[this.type];
    const tag = this.selectedTag;

    // ── movie: /api/douban with tag + type ──
    if (this.type === "movie") {
      const data = await api.getDoubanData("movie", tag, PAGE_SIZE, 0);
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── tv / show: /api/douban/categories ──
    if (this.type === "tv" || this.type === "show") {
      const data = await api.getDoubanCategories("tv", "最近热门", tag, PAGE_SIZE, 0);
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── anime ──
    if (this.type === "anime") {
      if (tag === "每日放送") {
        const calendar = await api.getBangumiCalendar();
        const day = calendar.find((d) => d.weekday?.en === this.selectedWeekday);
        // Bangumi items have a different shape — normalize to Douban-like.
        return (day?.items || []).map((item) => ({
          title: item.name_cn || item.name,
          poster: item.images?.common || item.images?.medium || item.images?.small || "",
          rate: item.rating?.score ? String(item.rating.score) : "",
          year: item.air_date || "",
          _bangumi: true,
        }));
      }
      if (tag === "番剧") {
        const data = await api.getDoubanRecommends("tv", { category: "动画", format: "电视剧", limit: PAGE_SIZE, year: this.selectedYear, sort: this.selectedSort });
        return Array.isArray(data?.list) ? data.list : [];
      }
      if (tag === "剧场版") {
        const data = await api.getDoubanRecommends("movie", { category: "动画", limit: PAGE_SIZE, year: this.selectedYear, sort: this.selectedSort });
        return Array.isArray(data?.list) ? data.list : [];
      }
    }

    return [];
  },

  _renderResults() {
    const body = this.container.querySelector("#searchBody");
    if (!this.results.length) {
      body.innerHTML = `<div class="empty-state">暂无内容</div>`;
      return;
    }
    const cards = this.results.slice(0, 120).map((r, i) => {
      const poster = api.getImageProxyUrl(r.poster);
      const title = this._escape(r.title || r.name_cn || r.name || "");
      const year = this._escape(r.year || "");
      const rate = r.rate ? `<span class="rate-badge">★ ${this._escape(r.rate)}</span>` : "";
      const sub = `${rate}${year ? `<span>${year}</span>` : ""}`;
      return `
        <div class="poster-card focusable" data-action="open-douban" data-index="${i}">
          <img class="poster-img" src="${poster}" alt="" loading="lazy" onerror="this.style.opacity=0.1" />
          <div class="poster-meta">
            <div class="poster-title">${title}</div>
            <div class="poster-sub">${sub}</div>
          </div>
        </div>
      `;
    }).join("");
    const cfg = TYPE_CONFIGS[this.type];
    const heading = `${cfg.label} · ${this._escape(this._currentTagLabel())}`;
    body.innerHTML = `<div class="section-title">${heading}</div><div class="poster-grid">${cards}</div>`;
    ScreenUtils.indexFocusables(body);
  },

  _currentTagLabel() {
    const cfg = TYPE_CONFIGS[this.type];
    const tag = cfg.tags.find((t) => (typeof t === "string" ? t === this.selectedTag : t.value === this.selectedTag));
    if (typeof tag === "string") return tag;
    return tag?.label || this.selectedTag;
  },

  _bindNav() {
    this.container.querySelectorAll('.nav-tab[data-action^="nav-"]').forEach((tab) => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        const action = tab.dataset.action;
        if (action === "nav-home") Router.navigate("home", {});
        else if (action === "nav-movie") Router.navigate("search", { type: "movie" });
        else if (action === "nav-tv") Router.navigate("search", { type: "tv" });
        else if (action === "nav-anime") Router.navigate("search", { type: "anime" });
        else if (action === "nav-show") Router.navigate("search", { type: "show" });
        else if (action === "nav-library") Router.navigate("library", {});
        else if (action === "nav-settings") Router.navigate("settings", {});
      });
    });
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    const focused = this.container.querySelector(".focused");

    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;

    if (code === 13) {
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "select-tag") {
        this.selectedTag = focused.dataset.value;
        // Reset weekday when switching to/from 每日放送.
        if (this.type === "anime") this.selectedWeekday = todayWeekday();
        // Reset sub-filters when switching tags.
        this.selectedYear = "all";
        this.selectedSort = "U";
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
      if (action === "select-year") {
        this.selectedYear = focused.dataset.value;
        this._renderFilters();
        this._loadCategory();
        return;
      }
      if (action === "select-sort") {
        this.selectedSort = focused.dataset.value;
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
      // Nav tabs — handle here for remote OK button (click events don't fire on TV).
      if (action === "nav-home") { Router.navigate("home", {}); return; }
      if (action === "nav-movie") { Router.navigate("search", { type: "movie" }); return; }
      if (action === "nav-tv") { Router.navigate("search", { type: "tv" }); return; }
      if (action === "nav-anime") { Router.navigate("search", { type: "anime" }); return; }
      if (action === "nav-show") { Router.navigate("search", { type: "show" }); return; }
      if (action === "nav-library") { Router.navigate("library", {}); return; }
      if (action === "nav-settings") { Router.navigate("settings", {}); return; }
    }
  },

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {
    if (this.abortCtrl) this.abortCtrl.abort();
    ScreenUtils.hide(this.container);
  }
};
