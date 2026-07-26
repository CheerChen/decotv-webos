// libraryScreen.js — favorites + play records.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { showToast } from "../../toast.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { escapeHtml } from "../../utils.js";

export const LibraryScreen = {
  container: null,
  tab: "favorites",
  favorites: {},
  records: {},

  async mount() {
    this.container = document.getElementById("library");
    this.favorites = {};
    this.records = {};
    this.container.innerHTML = `
      ${renderNavHeader("nav-library")}
      <div class="content-scroll" id="libraryScroll">
        <div style="display:flex;gap:14px;margin-bottom:20px;">
          <button class="btn focusable active" data-action="tab-favorites" id="tabFav">收藏</button>
          <button class="btn ghost focusable" data-action="tab-records" id="tabRec">播放记录</button>
        </div>
        <div id="libraryBody"><div class="center-wrap"><div class="loading-spinner"></div></div></div>
      </div>
    `;
    ScreenUtils.show(this.container);
    ScreenUtils.setInitialFocus(this.container.querySelector("#tabFav"));
    bindNavClicks(this.container);
    await this._loadTab("favorites");
  },

  async _loadTab(tab) {
    this.tab = tab;
    this.container.querySelector("#tabFav")?.classList.toggle("active", tab === "favorites");
    this.container.querySelector("#tabRec")?.classList.toggle("active", tab === "records");
    // Favorites & play records are stored on-device (see localLibrary.js).
    if (tab === "favorites") {
      const data = LocalLibrary.getFavorites();
      this.favorites = data && typeof data === "object" ? data : {};
      this._renderFavorites();
    } else {
      const data = LocalLibrary.getPlayRecords();
      this.records = data && typeof data === "object" ? data : {};
      this._renderRecords();
    }
  },

  _renderFavorites() {
    const body = this.container.querySelector("#libraryBody");
    const entries = Object.entries(this.favorites);
    if (!entries.length) {
      body.innerHTML = `<div class="empty-state">还没有收藏</div>`;
      return;
    }
    const cards = entries.map(([key, fav], i) => {
      const poster = api.getImageProxyUrl(fav.cover);
      const title = escapeHtml(fav.title || "");
      const sourceName = escapeHtml(fav.source_name || "");
      const year = escapeHtml(fav.year || "");
      const total = fav.total_episodes ? `${fav.total_episodes} 集` : "";
      const sub = [year, total, `<span class="source-pill">${sourceName}</span>`].filter(Boolean).join(" ");
      return `
        <div class="poster-card focusable" data-action="open-fav" data-key="${escapeHtml(key)}" data-index="${i}">
          <img class="poster-img" src="${poster}" alt="" loading="lazy" onerror="this.style.opacity=0.1" />
          <div class="poster-meta">
            <div class="poster-title">${title}</div>
            <div class="poster-sub">${sub}</div>
          </div>
        </div>
      `;
    }).join("");
    body.innerHTML = `<div class="poster-grid">${cards}</div>`;
    ScreenUtils.indexFocusables(body);
    ScreenUtils.setInitialFocus(body.querySelector(".poster-card"));
  },

  _renderRecords() {
    const body = this.container.querySelector("#libraryBody");
    const entries = Object.entries(this.records);
    if (!entries.length) {
      body.innerHTML = `<div class="empty-state">还没有播放记录</div>`;
      return;
    }
    const cards = entries.map(([key, rec], i) => {
      const poster = api.getImageProxyUrl(rec.cover);
      const title = escapeHtml(rec.title || "");
      const sourceName = escapeHtml(rec.source_name || "");
      const year = escapeHtml(rec.year || "");
      const idx = rec.index != null ? `看到第 ${rec.index} 集` : "";
      const sub = [year, idx, `<span class="source-pill">${sourceName}</span>`].filter(Boolean).join(" ");
      return `
        <div class="poster-card focusable" data-action="open-rec" data-key="${escapeHtml(key)}" data-index="${i}">
          <img class="poster-img" src="${poster}" alt="" loading="lazy" onerror="this.style.opacity=0.1" />
          <div class="poster-meta">
            <div class="poster-title">${title}</div>
            <div class="poster-sub">${sub}</div>
          </div>
        </div>
      `;
    }).join("");
    body.innerHTML = `<div class="poster-grid">${cards}</div>`;
    ScreenUtils.indexFocusables(body);
    ScreenUtils.setInitialFocus(body.querySelector(".poster-card"));
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    if (code === 13) {
      const focused = this.container.querySelector(".focused");
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "tab-favorites") { await this._loadTab("favorites"); return; }
      if (action === "tab-records") { await this._loadTab("records"); return; }
      if (action === "open-fav") {
        const key = focused.dataset.key;
        const fav = this.favorites[key];
        if (!fav) return;
        // Go to detail in prefer mode: re-search all sources + probe + pick best.
        Router.navigate("detail", { title: fav.search_title || fav.title, year: fav.year, autoPlay: true });
        return;
      }
      if (action === "open-rec") {
        const key = focused.dataset.key;
        const rec = this.records[key];
        if (!rec) return;
        Router.navigate("detail", { title: rec.title, year: rec.year, autoPlay: true });
        return;
      }
      if (handleNavAction(action)) return;
    }
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
