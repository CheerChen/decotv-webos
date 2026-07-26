// libraryScreen.js — favorites + play records.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { showToast } from "../../../core/network/toast.js";

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
      <div class="app-header">
        <div class="brand">DecoTV</div>
        <div class="nav-tabs">
          <div class="nav-tab focusable" data-action="nav-home">首页</div>
          <div class="nav-tab focusable" data-action="nav-movie">电影</div>
          <div class="nav-tab focusable" data-action="nav-tv">剧集</div>
          <div class="nav-tab focusable" data-action="nav-anime">动漫</div>
          <div class="nav-tab focusable" data-action="nav-show">综艺</div>
          <div class="nav-tab focusable active" data-action="nav-library">收藏</div>
          <div class="nav-tab focusable" data-action="nav-settings">设置</div>
        </div>
      </div>
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
    this._bindNav();
    await this._loadTab("favorites");
  },

  _bindNav() {
    this.container.querySelectorAll('.nav-tab[data-action^="nav-"]').forEach((tab) => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        const action = tab.dataset.action;
        if (action === "nav-home") Router.navigate("home", {});
        if (action === "nav-movie") Router.navigate("search", { type: "movie" });
        if (action === "nav-tv") Router.navigate("search", { type: "tv" });
        if (action === "nav-anime") Router.navigate("search", { type: "anime" });
        if (action === "nav-show") Router.navigate("search", { type: "show" });
        if (action === "nav-library") return;
        if (action === "nav-settings") Router.navigate("settings", {});
      });
    });
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
      const title = this._escape(fav.title || "");
      const sourceName = this._escape(fav.source_name || "");
      const year = this._escape(fav.year || "");
      const total = fav.total_episodes ? `${fav.total_episodes} 集` : "";
      const sub = [year, total, `<span class="source-pill">${sourceName}</span>`].filter(Boolean).join(" ");
      return `
        <div class="poster-card focusable" data-action="open-fav" data-key="${this._escape(key)}" data-index="${i}">
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
      const title = this._escape(rec.title || "");
      const sourceName = this._escape(rec.source_name || "");
      const year = this._escape(rec.year || "");
      const idx = rec.index != null ? `看到第 ${rec.index} 集` : "";
      const sub = [year, idx, `<span class="source-pill">${sourceName}</span>`].filter(Boolean).join(" ");
      return `
        <div class="poster-card focusable" data-action="open-rec" data-key="${this._escape(key)}" data-index="${i}">
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
      if (action === "nav-home") { Router.navigate("home", {}); return; }
      if (action === "nav-search") { Router.navigate("search", {}); return; }
      if (action === "nav-settings") { Router.navigate("settings", {}); return; }
    }
  },

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
