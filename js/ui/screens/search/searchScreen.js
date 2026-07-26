// searchScreen.js — aggregated multi-source search.
// Input box + search history + results grid. DecoTV search returns playable
// episode URLs directly, so tapping a result goes to detail screen.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalStore } from "../../../core/storage/localStore.js";

const HISTORY_KEY = "decotv.searchHistory";
const MAX_HISTORY = 12;

export const SearchScreen = {
  container: null,
  results: [],
  loading: false,
  query: "",
  abortCtrl: null,

  async mount(params = {}) {
    this.container = document.getElementById("search");
    this.results = [];
    this.query = params.q || "";
    this.container.innerHTML = `
      <div class="app-header">
        <div class="brand">DecoTV</div>
        <div class="nav-tabs">
          <div class="nav-tab focusable" data-action="nav-home">首页</div>
          <div class="nav-tab focusable active" data-action="nav-search">搜索</div>
          <div class="nav-tab focusable" data-action="nav-library">收藏</div>
          <div class="nav-tab focusable" data-action="nav-settings">设置</div>
        </div>
      </div>
      <div class="content-scroll" id="searchScroll">
        <div class="search-bar" style="padding:24px 0 16px;">
          <input id="searchInput" class="form-input focusable" type="text"
            autocomplete="off" spellcheck="false" placeholder="搜索影片…" style="max-width:900px;font-size:26px;" />
        </div>
        <div id="searchBody"></div>
      </div>
    `;
    ScreenUtils.show(this.container);
    const input = this.container.querySelector("#searchInput");
    if (input) {
      input.value = this.query;
      input.focus();
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      input.classList.add("focused");
      input.addEventListener("input", () => { this.query = input.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._doSearch(input.value); }
      });
    }
    if (params.autoSearch && this.query) {
      this._doSearch(this.query);
    } else if (!this.query) {
      this._renderHistory();
    }
    this._bindNav();
  },

  _bindNav() {
    this.container.querySelectorAll('.nav-tab[data-action^="nav-"]').forEach((tab) => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        const action = tab.dataset.action;
        if (action === "nav-home") Router.navigate("home", {});
        if (action === "nav-search") return;
        if (action === "nav-library") Router.navigate("library", {});
        if (action === "nav-settings") Router.navigate("settings", {});
      });
    });
  },

  async _doSearch(q) {
    const query = (q || "").trim();
    if (!query) return;
    this.query = query;
    this._saveHistory(query);
    if (this.abortCtrl) this.abortCtrl.abort();
    this.abortCtrl = new AbortController();
    this.loading = true;
    const body = this.container.querySelector("#searchBody");
    body.innerHTML = `<div class="center-wrap"><div class="loading-spinner"></div></div>`;
    try {
      const data = await api.searchVideos(query);
      this.results = Array.isArray(data?.results) ? data.results : [];
      this.loading = false;
      this._renderResults();
    } catch (e) {
      this.loading = false;
      body.innerHTML = `<div class="empty-state">搜索失败：${this._escape(e?.message || e)}</div>`;
    }
  },

  _renderResults() {
    const body = this.container.querySelector("#searchBody");
    if (!this.results.length) {
      body.innerHTML = `<div class="empty-state">没有匹配「${this._escape(this.query)}」的结果</div>`;
      return;
    }
    // Group identical titles from different sources for clarity.
    const cards = this.results.slice(0, 120).map((r, i) => {
      const poster = api.getImageProxyUrl(r.poster);
      const title = this._escape(r.title || "");
      const sourceName = this._escape(r.source_name || r.source || "");
      const year = this._escape(r.year || "");
      const typeName = this._escape(r.type_name || "");
      const epCount = Array.isArray(r.episodes) ? r.episodes.length : 0;
      const sub = [year, typeName, epCount ? `${epCount} 集` : "", `<span class="source-pill">${sourceName}</span>`]
        .filter(Boolean).join(" ");
      return `
        <div class="poster-card focusable" data-action="open-result" data-index="${i}">
          <img class="poster-img" src="${poster}" alt="" loading="lazy" onerror="this.style.opacity=0.1" />
          <div class="poster-meta">
            <div class="poster-title">${title}</div>
            <div class="poster-sub">${sub}</div>
          </div>
        </div>
      `;
    }).join("");
    body.innerHTML = `<div class="section-title">搜索结果（${this.results.length}）</div><div class="poster-grid">${cards}</div>`;
    ScreenUtils.indexFocusables(body);
    ScreenUtils.setInitialFocus(body.querySelector(".poster-card"));
  },

  _renderHistory() {
    const body = this.container.querySelector("#searchBody");
    const history = LocalStore.get(HISTORY_KEY, []);
    if (!history.length) {
      body.innerHTML = `<div class="empty-state">输入片名开始搜索</div>`;
      return;
    }
    const chips = history.map((h) => `
      <button class="btn ghost focusable" data-action="history" data-q="${this._escape(h)}">${this._escape(h)}</button>
    `).join("");
    body.innerHTML = `<div class="section-title">最近搜索</div><div style="display:flex;flex-wrap:wrap;gap:14px;">${chips}</div>
      <div style="margin-top:24px;"><button class="btn ghost focusable" data-action="clear-history">清空历史</button></div>`;
    ScreenUtils.indexFocusables(body);
  },

  _saveHistory(q) {
    let history = LocalStore.get(HISTORY_KEY, []);
    history = [q, ...history.filter((x) => x !== q)].slice(0, MAX_HISTORY);
    LocalStore.set(HISTORY_KEY, history);
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    const focused = this.container.querySelector(".focused");

    // If input is focused, let D-pad left/right move within text; up/down leave input.
    if (focused?.tagName === "INPUT") {
      if (code === 38 || code === 40) {
        // Move focus out of input to first poster card / history chip.
        const target = this.container.querySelector(".poster-card.focused, .btn.focused")
          || this.container.querySelector(".poster-card, .btn[data-action='history'], .btn[data-action='clear-history']");
        if (target) {
          this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
          target.classList.add("focused");
          target.focus();
        }
        return;
      }
      return;
    }

    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;

    if (code === 13) {
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "open-result") {
        const idx = Number(focused.dataset.index);
        const r = this.results[idx];
        if (!r) return;
        // From search we already have a specific source — go to detail in single
        // mode (no re-probe of all sources). User can still switch source from
        // the player's source panel if needed.
        Router.navigate("detail", { result: r, query: this.query, autoPlay: true });
        return;
      }
      if (action === "history") {
        const q = focused.dataset.q;
        const input = this.container.querySelector("#searchInput");
        if (input) input.value = q;
        this._doSearch(q);
        return;
      }
      if (action === "clear-history") {
        LocalStore.remove(HISTORY_KEY);
        this._renderHistory();
        return;
      }
      if (action === "nav-home") { Router.navigate("home", {}); return; }
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
