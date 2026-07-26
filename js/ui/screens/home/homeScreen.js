// homeScreen.js — Douban-powered poster wall.
// Loads multiple Douban tags as horizontal rows; D-pad moves between cards and rows.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { showToast } from "../../../core/network/toast.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";

const ROWS = [
  { type: "movie", tag: "热门", title: "热门电影" },
  { type: "tv", tag: "热门", title: "热门剧集" },
  { type: "movie", tag: "最新", title: "最新电影" },
  { type: "tv", tag: "最新", title: "最新剧集" },
  { type: "movie", tag: "经典", title: "经典电影" },
  { type: "tv", tag: "经典", title: "经典剧集" }
];

const PAGE_SIZE = 24;

export const HomeScreen = {
  container: null,
  rowsData: [],
  loading: true,

  async mount() {
    this.container = document.getElementById("home");
    this.rowsData = [];
    this.loading = true;
    this.container.innerHTML = `
      <div class="app-header">
        <div class="brand">DecoTV</div>
        <div class="nav-tabs">
          <div class="nav-tab focusable active" data-action="nav-home">首页</div>
          <div class="nav-tab focusable" data-action="nav-search">搜索</div>
          <div class="nav-tab focusable" data-action="nav-library">收藏</div>
          <div class="nav-tab focusable" data-action="nav-settings">设置</div>
        </div>
      </div>
      <div class="content-scroll" id="homeScroll">
        <div class="center-wrap" id="homeLoading"><div class="loading-spinner"></div></div>
      </div>
    `;
    ScreenUtils.show(this.container);
    ScreenUtils.setInitialFocus(this.container.querySelector('.nav-tab[data-action="nav-home"]'));
    this._loadRows();
  },

  async _loadRows() {
    const scroll = this.container.querySelector("#homeScroll");

    // Build the "继续观看" row from device-local play records (mirrors PC
    // home's first row). Sorted by save_time descending; only shown when
    // there is at least one record. Renders synchronously from localStorage
    // so it appears before the async Douban rows.
    const records = this._renderHistoryRow();

    // Fetch all Douban rows in parallel; render incrementally as each arrives.
    const results = new Array(ROWS.length).fill(null);
    let firstRendered = false;

    const renderReady = () => {
      let html = records;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r) break;
        if (r.error) {
          html += `<div class="section-title">${r.row.title}</div><div class="empty-state">加载失败</div>`;
        } else if (r.list.length === 0) {
          html += `<div class="section-title">${r.row.title}</div><div class="empty-state">暂无内容</div>`;
        } else {
          html += this._renderRow(r.row, r.list, i);
        }
      }
      scroll.innerHTML = html;
      ScreenUtils.indexFocusables(scroll);
      if (!firstRendered) {
        const first = scroll.querySelector(".poster-card");
        if (first) { ScreenUtils.setInitialFocus(first); firstRendered = true; }
      }
    };

    const promises = ROWS.map((row, i) =>
      api.getDoubanData(row.type, row.tag, PAGE_SIZE, 0)
        .then((data) => {
          const list = Array.isArray(data?.list) ? data.list : [];
          this.rowsData[i] = { ...row, items: list };
          results[i] = { row, list, error: null };
        })
        .catch((e) => {
          this.rowsData[i] = { ...row, items: [], error: String(e?.message || e) };
          results[i] = { row, list: [], error: String(e?.message || e) };
        })
        .then(renderReady)
    );

    await Promise.all(promises);
    this.loading = false;
  },

  // Render the "继续观看" row from play records. Returns the HTML string
  // (empty when there are no records, so the row is simply absent).
  _renderHistoryRow() {
    const all = LocalLibrary.getPlayRecords();
    const entries = Object.entries(all)
      .filter(([, rec]) => rec && rec.title)
      .sort((a, b) => (b[1].save_time || 0) - (a[1].save_time || 0))
      .slice(0, PAGE_SIZE);
    if (!entries.length) return "";
    this.historyRecords = entries;
    const cards = entries.map(([key, rec], idx) => {
      const poster = api.getImageProxyUrl(rec.cover);
      const title = this._escape(rec.title || "");
      const ep = rec.total_episodes > 1 && rec.index ? `看到第 ${rec.index} 集` : "";
      const progress = rec.total_time > 0
        ? `${this._fmtTime(rec.play_time)} / ${this._fmtTime(rec.total_time)}`
        : "";
      const sub = [ep, progress].filter(Boolean).join(" · ");
      return `
        <div class="poster-card focusable" data-action="open-rec" data-key="${this._escape(key)}" data-col="${idx}">
          <img class="poster-img" src="${poster}" alt="" loading="lazy" onerror="this.style.opacity=0.1" />
          <div class="poster-meta">
            <div class="poster-title">${title}</div>
            <div class="poster-sub">${sub}</div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="section-title">继续观看</div>
      <div class="poster-row" data-row="history">${cards}</div>
    `;
  },

  _fmtTime(s) {
    const t = Math.max(0, Math.floor(Number(s || 0)));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  },

  _renderRow(row, list, rowIndex) {
    if (!list.length) {
      return `<div class="section-title">${row.title}</div><div class="empty-state">暂无内容</div>`;
    }
    const cards = list.map((item, idx) => this._renderCard(item, rowIndex, idx)).join("");
    return `
      <div class="section-title">${row.title}</div>
      <div class="poster-row" data-row="${rowIndex}">${cards}</div>
    `;
  },

  _renderCard(item, rowIndex, idx) {
    const poster = api.getImageProxyUrl(item.poster);
    const title = this._escape(item.title || "");
    const rate = item.rate ? `<span class="rate-badge">★ ${this._escape(item.rate)}</span>` : "";
    const year = item.year ? this._escape(item.year) : "";
    return `
      <div class="poster-card focusable" data-action="open-douban" data-title="${title}" data-poster="${this._escape(poster)}" data-row="${rowIndex}" data-col="${idx}">
        <img class="poster-img" src="${poster}" alt="" loading="lazy" onerror="this.style.opacity=0.1" />
        <div class="poster-meta">
          <div class="poster-title">${title}</div>
          <div class="poster-sub">${rate}${year ? `<span>${year}</span>` : ""}</div>
        </div>
      </div>
    `;
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    // D-pad navigation across all focusables within home screen.
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;

    if (code === 13) {
      const focused = this.container.querySelector(".focused");
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "open-douban") {
        const title = focused.dataset.title;
        const poster = focused.dataset.poster;
        // Match PC flow: go straight to detail which will search all sources,
        // probe them, pick the best, and start playback.
        Router.navigate("detail", { title, poster, autoPlay: true });
        return;
      }
      if (action === "open-rec") {
        const key = focused.dataset.key;
        const rec = this.historyRecords?.find(([k]) => k === key)?.[1];
        if (!rec) return;
        Router.navigate("detail", { title: rec.title, year: rec.year, autoPlay: true });
        return;
      }
      if (action === "nav-home") return;
      if (action === "nav-search") { Router.navigate("search", {}); return; }
      if (action === "nav-library") { Router.navigate("library", {}); return; }
      if (action === "nav-settings") { Router.navigate("settings", {}); return; }
    }
  },

  consumeBackRequest() {
    // Back on home → let router close app (handled in router).
    return false;
  },

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
