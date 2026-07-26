// settingsScreen.js — server info, change server, logout.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { api, STORAGE_BASEURL } from "../../../core/network/decotvClient.js";
import { LocalStore } from "../../../core/storage/localStore.js";
import { showToast } from "../../../core/network/toast.js";

export const SettingsScreen = {
  container: null,

  async mount() {
    this.container = document.getElementById("settings");
    const baseUrl = api.getStoredBaseUrl() || "—";
    const siteName = AuthManager.serverConfig?.SiteName || "—";
    const version = AuthManager.serverConfig?.Version || "—";
    const storageType = AuthManager.serverConfig?.StorageType || "—";
    const authMode = AuthManager.serverConfig?.AuthMode || "—";
    this.container.innerHTML = `
      <div class="app-header">
        <div class="brand">DecoTV</div>
        <div class="nav-tabs">
          <div class="nav-tab focusable" data-action="nav-home">首页</div>
          <div class="nav-tab focusable" data-action="nav-movie">电影</div>
          <div class="nav-tab focusable" data-action="nav-tv">剧集</div>
          <div class="nav-tab focusable" data-action="nav-anime">动漫</div>
          <div class="nav-tab focusable" data-action="nav-show">综艺</div>
          <div class="nav-tab focusable" data-action="nav-library">收藏</div>
          <div class="nav-tab focusable active" data-action="nav-settings">设置</div>
        </div>
      </div>
      <div class="content-scroll" id="settingsScroll">
        <div class="section-title">服务器</div>
        <div class="settings-list">
          <div class="settings-item">
            <div class="settings-label">站点名称</div>
            <div class="settings-value">${this._escape(siteName)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">服务器地址</div>
            <div class="settings-value">${this._escape(baseUrl)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">版本</div>
            <div class="settings-value">${this._escape(version)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">存储模式</div>
            <div class="settings-value">${this._escape(storageType)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">认证模式</div>
            <div class="settings-value">${this._escape(authMode)}</div>
          </div>
          <div class="settings-item focusable" data-action="change-server">
            <div class="settings-label">切换服务器</div>
            <div class="settings-value">›</div>
          </div>
        </div>
      </div>
    `;
    ScreenUtils.show(this.container);
    this._bindNav();
    ScreenUtils.setInitialFocus(this.container.querySelector('.settings-item[data-action="change-server"]'));
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
        if (action === "nav-library") Router.navigate("library", {});
        if (action === "nav-settings") return;
      });
    });
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    if (code === 13) {
      const focused = this.container.querySelector(".focused");
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "change-server") {
        // Clear stored URL and bounce to server screen.
        LocalStore.remove(STORAGE_BASEURL);
        api.setBaseUrl("");
        AuthManager.reset();
        Router.navigate("server", {}, { replaceHistory: true });
        return;
      }
      if (action === "nav-home") { Router.navigate("home", {}); return; }
      if (action === "nav-search") { Router.navigate("search", {}); return; }
      if (action === "nav-library") { Router.navigate("library", {}); return; }
    }
  },

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
