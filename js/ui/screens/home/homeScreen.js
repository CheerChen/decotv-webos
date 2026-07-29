// homeScreen.js — Douban-powered poster wall.
// Loads multiple Douban tags as horizontal rows; D-pad moves between cards and rows.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { showToast } from "../../toast.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { posterAttrs } from "../../posterImage.js";
import { escapeHtml, formatTime } from "../../utils.js";

// Home rows. `fetch` selects the API:
//   douban     — /api/douban?type&tag  (movie/tv 热门 charts)
//   recommends — /api/douban/recommends with sort=R (首播/上映时间) for 最新*
//                 (tv tag=最新 on /api/douban returns empty on DecoTV)
// Classic rows removed — those live under the category tabs.
const ROWS = [
  { title: "热门电影", fetch: "douban", type: "movie", tag: "热门" },
  { title: "热门剧集", fetch: "douban", type: "tv", tag: "热门" },
  {
    title: "最新电影",
    fetch: "recommends",
    kind: "movie",
    sort: "R"
  },
  {
    title: "最新剧集",
    fetch: "recommends",
    kind: "tv",
    format: "电视剧",
    sort: "R"
  }
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
      ${renderNavHeader("nav-home")}
      <div class="content-scroll" id="homeScroll">
        <div class="center-wrap" id="homeLoading"><div class="loading-spinner"></div></div>
      </div>
    `;
    ScreenUtils.show(this.container);
    bindNavClicks(this.container);
    ScreenUtils.setInitialFocus(this.container.querySelector('.nav-tab[data-action="nav-home"]'));
    this._loadRows();
  },

  async _loadRows() {
    const scroll = this.container.querySelector("#homeScroll");

    // Fetch all Douban rows in parallel; render incrementally as each arrives.
    const results = new Array(ROWS.length).fill(null);
    let firstRendered = false;

    const renderReady = () => {
      // The "继续观看" row (mirrors PC home's first row) is rebuilt on every
      // pass rather than captured once, so a library pull landing mid-load is
      // picked up for free. It is a localStorage read, sorted and sliced.
      let html = this._renderHistoryRow();
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
    // Exposed so a library pull that lands after loading finished can still
    // refresh the history row. firstRendered has been set by then, so this
    // cannot yank focus back to the first card.
    this._renderReady = renderReady;

    const promises = ROWS.map((row, i) =>
      this._fetchRow(row)
        .then((list) => {
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

  async _fetchRow(row) {
    if (row.fetch === "recommends") {
      const data = await api.getDoubanRecommends(row.kind, {
        format: row.format || "",
        category: row.category || "",
        sort: row.sort || "R",
        limit: PAGE_SIZE,
        start: 0
      });
      return Array.isArray(data?.list) ? data.list : [];
    }
    // Default: classic /api/douban chart by type + tag.
    const data = await api.getDoubanData(row.type, row.tag, PAGE_SIZE, 0);
    return Array.isArray(data?.list) ? data.list : [];
  },

  // Called by librarySync once a pull has changed the local store. Re-running
  // the render replaces #homeScroll wholesale, which destroys the .focused
  // node, so the cursor is pinned to the same card by identity rather than by
  // position — the history row can gain or lose entries in the same pass.
  refreshLibraryData() {
    const scroll = this.container?.querySelector("#homeScroll");
    if (!scroll || !this._renderReady) return;
    const markerOf = (node) => (node
      ? `${node.dataset.action || ""}|${node.dataset.key || ""}|${node.dataset.col || ""}`
      : "");
    const marker = markerOf(scroll.querySelector(".focused"));
    this._renderReady();
    if (!marker) return;
    const restored = Array.from(scroll.querySelectorAll(".focusable"))
      .find((node) => markerOf(node) === marker);
    if (restored) ScreenUtils.setInitialFocus(restored);
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
      const poster = posterAttrs(rec.cover);
      const title = escapeHtml(rec.title || "");
      const ep = rec.total_episodes > 1 && rec.index ? `看到第 ${rec.index} 集` : "";
      const progress = rec.total_time > 0
        ? `${formatTime(rec.play_time)} / ${formatTime(rec.total_time)}`
        : "";
      const sub = [ep, progress].filter(Boolean).join(" · ");
      return `
        <div class="poster-card focusable" data-action="open-rec" data-key="${escapeHtml(key)}" data-col="${idx}">
          <img class="poster-img" ${poster} alt="" loading="lazy" onerror="this.style.opacity=0.1" />
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
    const poster = posterAttrs(item.poster);
    // data-poster keeps the raw URL; detail will re-proxy. Avoid storing the
    // already-proxied src (breaks when baseURL changes / double-encodes).
    const rawPoster = item.poster || "";
    const title = escapeHtml(item.title || "");
    const rate = item.rate ? `<span class="rate-badge">★ ${escapeHtml(item.rate)}</span>` : "";
    const year = item.year ? escapeHtml(item.year) : "";
    return `
      <div class="poster-card focusable" data-action="open-douban" data-title="${title}" data-poster="${escapeHtml(rawPoster)}" data-row="${rowIndex}" data-col="${idx}">
        <img class="poster-img" ${poster} alt="" loading="lazy" onerror="this.style.opacity=0.1" />
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
        Router.navigate("detail", {
          title: rec.title,
          year: rec.year,
          poster: rec.cover || "",
          autoPlay: true
        });
        return;
      }
      if (action === "nav-home") return;
      if (handleNavAction(action)) return;
    }
  },

  consumeBackRequest() {
    // Back on home → let router close app (handled in router).
    return false;
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
