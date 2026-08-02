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
import { posterAttrs } from "../../posterImage.js";
import { escapeHtml } from "../../utils.js";
import { TYPE_CONFIGS, WEEKDAYS, todayWeekday, bangumiToCards } from "./browseConfig.js";

const PAGE_SIZE = 24;

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
    // Digit shortcuts request first-cover focus; tab clicks leave the default
    // (filter chip) so D-pad filter browsing is unchanged.
    this.focusFirstItem = Boolean(params.focusFirstItem);
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
        return bangumiToCards(calendar, this.selectedWeekday);
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
        return bangumiToCards(calendar, this.selectedWeekday);
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
    const cards = this.results.slice(0, 120).map((r, i) => {
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
    }).join("");
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
