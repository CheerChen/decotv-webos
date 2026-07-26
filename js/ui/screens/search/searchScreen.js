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

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { escapeHtml } from "../../utils.js";

const PAGE_SIZE = 24;

// ── Shared filter option sets ───────────────────────────────────────────────

const YEAR_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "2026", value: "2026" },
  { label: "2025", value: "2025" },
  { label: "2024", value: "2024" },
  { label: "2023", value: "2023" },
  { label: "2022", value: "2022" },
  { label: "2021", value: "2021" },
  { label: "2020", value: "2020" },
  { label: "2020年代", value: "2020年代" },
  { label: "2010年代", value: "2010年代" },
  { label: "2000年代", value: "2000年代" },
  { label: "90年代", value: "90年代" },
  { label: "80年代", value: "80年代" },
  { label: "更早", value: "更早" },
];

const SORT_OPTIONS = [
  { label: "高分优先", value: "S" },
  { label: "近期热度", value: "U" },
  { label: "首播时间", value: "R" },
  { label: "综合排序", value: "T" },
];

// Movie genres for recommend tab (15 types, all return 23 items).
const MOVIE_GENRES = [
  { label: "全部", value: "" },
  { label: "剧情", value: "剧情" },
  { label: "喜剧", value: "喜剧" },
  { label: "爱情", value: "爱情" },
  { label: "科幻", value: "科幻" },
  { label: "悬疑", value: "悬疑" },
  { label: "动作", value: "动作" },
  { label: "动画", value: "动画" },
  { label: "奇幻", value: "奇幻" },
  { label: "惊悚", value: "惊悚" },
  { label: "犯罪", value: "犯罪" },
  { label: "战争", value: "战争" },
  { label: "历史", value: "历史" },
  { label: "音乐", value: "音乐" },
  { label: "歌舞", value: "歌舞" },
  { label: "西部", value: "西部" },
];

// TV genres for recommend tab (13 types that return 24 items).
const TV_GENRES = [
  { label: "全部", value: "" },
  { label: "剧情", value: "剧情" },
  { label: "喜剧", value: "喜剧" },
  { label: "爱情", value: "爱情" },
  { label: "科幻", value: "科幻" },
  { label: "悬疑", value: "悬疑" },
  { label: "动作", value: "动作" },
  { label: "奇幻", value: "奇幻" },
  { label: "惊悚", value: "惊悚" },
  { label: "犯罪", value: "犯罪" },
  { label: "战争", value: "战争" },
  { label: "历史", value: "历史" },
  { label: "音乐", value: "音乐" },
  { label: "歌舞", value: "歌舞" },
];

// Show sub-genres for recommend tab (综艺-specific types).
const SHOW_GENRES = [
  { label: "全部", value: "" },
  { label: "真人秀", value: "真人秀" },
  { label: "脱口秀", value: "脱口秀" },
  { label: "谈话", value: "谈话" },
];

// Full region list for recommend tabs (11 regions, all return 24 items).
const REGIONS_FULL = [
  { label: "全部", value: "" },
  { label: "华语", value: "华语" },
  { label: "欧美", value: "欧美" },
  { label: "美国", value: "美国" },
  { label: "日本", value: "日本" },
  { label: "韩国", value: "韩国" },
  { label: "中国", value: "中国" },
  { label: "中国香港", value: "中国香港" },
  { label: "中国台湾", value: "中国台湾" },
  { label: "法国", value: "法国" },
  { label: "英国", value: "英国" },
  { label: "印度", value: "印度" },
];

// Anime regions (subset — recommend category=动画 works with these 4).
const REGIONS_ANIME = [
  { label: "全部", value: "" },
  { label: "日本", value: "日本" },
  { label: "欧美", value: "欧美" },
  { label: "华语", value: "华语" },
];

// Documentary regions (subset for recommend format=纪录片).
const REGIONS_DOC = [
  { label: "全部", value: "" },
  { label: "华语", value: "华语" },
  { label: "欧美", value: "欧美" },
  { label: "日本", value: "日本" },
  { label: "韩国", value: "韩国" },
];

// ── Per-tab config ──────────────────────────────────────────────────────────
//
// Each tab has:
//   label     — display name (for heading)
//   endpoint  — "recent_hot" | "recommend" | "mixed"
//   filters   — array of { id, label, options, default, showWhen? }
//
// recent_hot tabs: filters map to getDoubanCategories(kind, category, type).
//   rhKind / rhCategory come from config; the "type" filter provides the 3rd param.
//   For hot-movie, "category" filter = sub-chart, "type" filter = region.
//
// recommend tabs: filters map to getDoubanRecommends(kind, { category, format, region, year, sort }).
//   recKind / recFormat / recCategory(fixed) come from config.
//
// mixed tabs (documentary): "mode" filter switches between recent_hot and recommend.
//   mode=hot → recent_hot (no extra filters).
//   mode=curated → recommend (region/year/sort filters visible via showWhen).

const TYPE_CONFIGS = {
  // ── 热门系列 (recent_hot) ──
  "hot-movie": {
    label: "热门电影",
    endpoint: "recent_hot",
    rhKind: "movie",
    filters: [
      {
        id: "category", label: "分类",
        options: [
          { label: "热门电影", value: "热门" },
          { label: "最新电影", value: "最新" },
          { label: "豆瓣高分", value: "豆瓣高分" },
          { label: "冷门佳片", value: "冷门佳片" },
        ],
        default: "热门",
      },
      {
        id: "type", label: "地区",
        options: [
          { label: "全部", value: "全部" },
          { label: "华语", value: "华语" },
          { label: "欧美", value: "欧美" },
          { label: "韩国", value: "韩国" },
          { label: "日本", value: "日本" },
        ],
        default: "全部",
      },
    ],
  },
  "hot-tv": {
    label: "热门剧集",
    endpoint: "recent_hot",
    rhKind: "tv",
    rhCategory: "tv",
    filters: [
      {
        id: "type", label: "类型",
        options: [
          { label: "全部", value: "tv" },
          { label: "国产", value: "tv_domestic" },
          { label: "欧美", value: "tv_american" },
          { label: "日本", value: "tv_japanese" },
          { label: "韩国", value: "tv_korean" },
        ],
        default: "tv",
      },
    ],
  },
  "hot-anime": {
    label: "热门动漫",
    endpoint: "mixed-anime",
    filters: [
      {
        id: "type", label: "分类",
        options: [
          { label: "全部", value: "tv_animation" },
          { label: "国产", value: "华语" },
          { label: "日本", value: "日本" },
          { label: "欧美", value: "欧美" },
          { label: "每日放送", value: "每日放送" },
        ],
        default: "tv_animation",
      },
    ],
    hasWeekday: true,
  },
  "hot-show": {
    label: "热门综艺",
    endpoint: "recent_hot",
    rhKind: "tv",
    rhCategory: "show",
    filters: [
      {
        id: "type", label: "地区",
        options: [
          { label: "全部", value: "show" },
          { label: "国内", value: "show_domestic" },
          { label: "国外", value: "show_foreign" },
        ],
        default: "show",
      },
    ],
  },

  // ── 精选系列 (recommend) ──
  "movie": {
    label: "电影",
    endpoint: "recommend",
    recKind: "movie",
    filters: [
      { id: "category", label: "类型", options: MOVIE_GENRES, default: "" },
      { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
  },
  "tv": {
    label: "剧集",
    endpoint: "recommend",
    recKind: "tv",
    recFormat: "电视剧",
    filters: [
      { id: "category", label: "类型", options: TV_GENRES, default: "" },
      { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
  },
  "anime": {
    label: "动漫",
    endpoint: "recommend",
    recKind: "tv",
    recFormat: "电视剧",
    recCategory: "动画",
    filters: [
      { id: "region", label: "地区", options: REGIONS_ANIME, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
  },
  "show": {
    label: "综艺",
    endpoint: "recommend",
    recKind: "tv",
    recFormat: "综艺",
    filters: [
      { id: "category", label: "类型", options: SHOW_GENRES, default: "" },
      { id: "region", label: "地区", options: REGIONS_FULL, default: "" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S" },
    ],
  },

  // ── 纪录片 (mixed: recent_hot default + recommend curated) ──
  "documentary": {
    label: "纪录片",
    endpoint: "mixed",
    filters: [
      {
        id: "mode", label: "分类",
        options: [
          { label: "热门榜单", value: "hot" },
          { label: "精选筛选", value: "curated" },
        ],
        default: "hot",
      },
      { id: "region", label: "地区", options: REGIONS_DOC, default: "", showWhen: "curated" },
      { id: "year", label: "年代", options: YEAR_OPTIONS, default: "all", showWhen: "curated" },
      { id: "sort", label: "排序", options: SORT_OPTIONS, default: "S", showWhen: "curated" },
    ],
  },
};

// Bangumi weekday labels for hot-anime "每日放送".
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
  type: "hot-movie",
  // Unified filter state: { filterId: selectedValue }.
  filterValues: {},
  selectedWeekday: null,
  abortCtrl: null,

  async mount(params = {}) {
    this.container = document.getElementById("search");
    this.results = [];
    this.type = params.type || "hot-movie";
    const cfg = TYPE_CONFIGS[this.type] || TYPE_CONFIGS["hot-movie"];
    // Initialize filter values to defaults.
    this.filterValues = {};
    for (const f of cfg.filters) {
      this.filterValues[f.id] = f.default;
    }
    this.selectedWeekday = this.type === "hot-anime" ? todayWeekday() : null;
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
  _renderFilters() {
    const wrap = this.container.querySelector("#searchFilters");
    const cfg = TYPE_CONFIGS[this.type] || TYPE_CONFIGS["hot-movie"];

    // Build chip rows from config filters.
    const rows = [];
    for (const f of cfg.filters) {
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

    // Weekday row for hot-anime "每日放送".
    let weekdayHtml = "";
    if (cfg.hasWeekday && this.filterValues.type === "每日放送") {
      weekdayHtml = `<div class="chip-row" id="weekdayRow"><span class="chip-label">星期</span>${
        WEEKDAYS.map((d) => {
          const active = d.value === this.selectedWeekday ? " active" : "";
          return `<button class="btn chip focusable${active}" data-action="select-weekday" data-value="${d.value}">${d.label}</button>`;
        }).join("")
      }</div>`;
    }

    wrap.innerHTML = rows.join("") + weekdayHtml;

    // Default focus: first active filter chip, or first chip.
    const defaultFocus = wrap.querySelector('[data-action="select-filter"].active') || wrap.querySelector('[data-action="select-filter"]') || wrap.querySelector('[data-action="select-weekday"]');
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
      body.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(e?.message || e)}</div>`;
    }
  },

  // Dispatch to the correct API based on endpoint type + filter values.
  async _fetchCategory() {
    const cfg = TYPE_CONFIGS[this.type];
    const fv = this.filterValues;

    // ── mixed-anime (hot-anime): 全部/每日放送 → recent_hot, 国家 → recommend ──
    if (cfg.endpoint === "mixed-anime") {
      const t = fv.type;
      // Bangumi special case for "每日放送".
      if (t === "每日放送") {
        const calendar = await api.getBangumiCalendar();
        const day = calendar.find((d) => d.weekday?.en === this.selectedWeekday);
        return (day?.items || []).map((item) => ({
          title: item.name_cn || item.name,
          poster: item.images?.common || item.images?.medium || item.images?.small || "",
          rate: item.rating?.score ? String(item.rating.score) : "",
          year: item.air_date || "",
          _bangumi: true,
        }));
      }
      // "全部" → recent_hot anime chart.
      if (t === "tv_animation") {
        const data = await api.getDoubanCategories("tv", "tv", "tv_animation", PAGE_SIZE, 0);
        return Array.isArray(data?.list) ? data.list : [];
      }
      // Country filter (华语/日本/欧美) → recommend category=动画, sort=U (近期热度).
      const data = await api.getDoubanRecommends("tv", {
        category: "动画", format: "电视剧", region: t, sort: "U", limit: PAGE_SIZE,
      });
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── recent_hot ──
    if (cfg.endpoint === "recent_hot") {
      // Bangumi special case for hot-anime "每日放送".
      if (cfg.hasWeekday && fv.type === "每日放送") {
        const calendar = await api.getBangumiCalendar();
        const day = calendar.find((d) => d.weekday?.en === this.selectedWeekday);
        return (day?.items || []).map((item) => ({
          title: item.name_cn || item.name,
          poster: item.images?.common || item.images?.medium || item.images?.small || "",
          rate: item.rating?.score ? String(item.rating.score) : "",
          year: item.air_date || "",
          _bangumi: true,
        }));
      }
      const kind = cfg.rhKind;
      const category = cfg.rhCategory || fv.category;
      const type = fv.type;
      const data = await api.getDoubanCategories(kind, category, type, PAGE_SIZE, 0);
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
      });
      return Array.isArray(data?.list) ? data.list : [];
    }

    // ── mixed (documentary) ──
    if (cfg.endpoint === "mixed") {
      if (fv.mode === "hot") {
        const data = await api.getDoubanCategories("tv", "tv", "tv_documentary", PAGE_SIZE, 0);
        return Array.isArray(data?.list) ? data.list : [];
      }
      // curated → recommend
      const data = await api.getDoubanRecommends("tv", {
        format: "纪录片",
        region: fv.region || "",
        year: fv.year || "",
        sort: fv.sort || "",
        limit: PAGE_SIZE,
      });
      return Array.isArray(data?.list) ? data.list : [];
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
      const title = escapeHtml(r.title || r.name_cn || r.name || "");
      const year = escapeHtml(r.year || "");
      const rate = r.rate ? `<span class="rate-badge">★ ${escapeHtml(r.rate)}</span>` : "";
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
    const heading = `${cfg.label} · ${escapeHtml(this._currentTagLabel())}`;
    body.innerHTML = `<div class="section-title">${heading}</div><div class="poster-grid">${cards}</div>`;
    ScreenUtils.indexFocusables(body);
  },

  // Build heading suffix from active filter labels.
  _currentTagLabel() {
    const cfg = TYPE_CONFIGS[this.type];
    const parts = [];
    for (const f of cfg.filters) {
      // Skip filters that are not visible (showWhen not met).
      if (f.showWhen) {
        const showVal = typeof f.showWhen === "string" ? f.showWhen : f.showWhen.value;
        if (this.filterValues.mode !== showVal) continue;
      }
      const opt = f.options.find((o) => o.value === this.filterValues[f.id]);
      const label = opt?.label || this.filterValues[f.id];
      // Skip "全部" in heading to keep it concise — except for single-filter tabs.
      if (label === "全部" && cfg.filters.length > 1) continue;
      parts.push(label);
    }
    // Add weekday for hot-anime 每日放送.
    if (cfg.hasWeekday && this.filterValues.type === "每日放送") {
      const wd = WEEKDAYS.find((d) => d.value === this.selectedWeekday);
      parts.push(wd?.label || this.selectedWeekday);
    }
    return parts.join(" · ") || "全部";
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    const focused = this.container.querySelector(".focused");

    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;

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
    if (this.abortCtrl) this.abortCtrl.abort();
    ScreenUtils.hide(this.container);
  }
};
