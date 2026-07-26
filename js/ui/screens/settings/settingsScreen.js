// settingsScreen.js — server info, change server, logout.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { api, STORAGE_BASEURL } from "../../../core/network/decotvClient.js";
import { LocalStore } from "../../../core/storage/localStore.js";
import { showToast } from "../../toast.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { escapeHtml } from "../../utils.js";

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
      ${renderNavHeader("nav-settings")}
      <div class="content-scroll" id="settingsScroll">
        <div class="section-title">服务器</div>
        <div class="settings-list">
          <div class="settings-item">
            <div class="settings-label">站点名称</div>
            <div class="settings-value">${escapeHtml(siteName)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">服务器地址</div>
            <div class="settings-value">${escapeHtml(baseUrl)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">版本</div>
            <div class="settings-value">${escapeHtml(version)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">存储模式</div>
            <div class="settings-value">${escapeHtml(storageType)}</div>
          </div>
          <div class="settings-item">
            <div class="settings-label">认证模式</div>
            <div class="settings-value">${escapeHtml(authMode)}</div>
          </div>
          <div class="settings-item focusable" data-action="change-server">
            <div class="settings-label">切换服务器</div>
            <div class="settings-value">›</div>
          </div>
        </div>
      </div>
    `;
    ScreenUtils.show(this.container);
    bindNavClicks(this.container);
    ScreenUtils.setInitialFocus(this.container.querySelector('.settings-item[data-action="change-server"]'));
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
      if (handleNavAction(action)) return;
    }
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
