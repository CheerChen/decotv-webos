// settingsScreen.js — actions on the left, read-only info on the right.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { api, STORAGE_BASEURL } from "../../../core/network/decotvClient.js";
import { LocalStore } from "../../../core/storage/localStore.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { showToast } from "../../toast.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { escapeHtml } from "../../utils.js";

// Fallback when webOS.fetchAppInfo is unavailable (desktop / tests).
// Keep in sync with appinfo.json / package.json.
const CLIENT_VERSION_FALLBACK = "0.4.0";

function readClientVersion() {
  return new Promise((resolve) => {
    try {
      if (typeof webOS !== "undefined" && typeof webOS.fetchAppInfo === "function") {
        webOS.fetchAppInfo((info) => {
          resolve((info && info.version) || CLIENT_VERSION_FALLBACK);
        });
        return;
      }
    } catch (_) { /* fall through */ }
    resolve(CLIENT_VERSION_FALLBACK);
  });
}

function infoRow(label, value) {
  return `
    <div class="settings-item settings-item-readonly">
      <div class="settings-label">${escapeHtml(label)}</div>
      <div class="settings-value">${escapeHtml(value)}</div>
    </div>
  `;
}

export const SettingsScreen = {
  container: null,

  async mount() {
    this.container = document.getElementById("settings");
    const baseUrl = api.getStoredBaseUrl() || "—";
    const siteName = AuthManager.serverConfig?.SiteName || "—";
    const serverVersion = AuthManager.serverConfig?.Version || "—";
    const storageType = AuthManager.serverConfig?.StorageType || "—";
    const authMode = AuthManager.serverConfig?.AuthMode || "—";
    const clientVersion = await readClientVersion();

    // Left: focusable actions. Right: read-only client + server facts.
    this.container.innerHTML = `
      ${renderNavHeader("nav-settings")}
      <div class="content-scroll" id="settingsScroll">
        <div class="settings-layout">
          <div class="settings-col settings-col-actions">
            <div class="section-title">选项</div>
            <div class="settings-list">
              <div class="settings-item focusable" data-action="change-server">
                <div class="settings-label">切换服务器</div>
                <div class="settings-value">›</div>
              </div>
              <div class="settings-item focusable" data-action="clear-records">
                <div class="settings-label">清空播放记录</div>
                <div class="settings-value">›</div>
              </div>
            </div>
          </div>
          <div class="settings-col settings-col-info">
            <div class="section-title">本机信息</div>
            <div class="settings-list">
              ${infoRow("应用版本", clientVersion)}
              ${infoRow("应用 ID", "com.cheerchen.decotv")}
            </div>
            <div class="section-title">服务器信息</div>
            <div class="settings-list">
              ${infoRow("站点名称", siteName)}
              ${infoRow("服务器地址", baseUrl)}
              ${infoRow("服务端版本", serverVersion)}
              ${infoRow("存储模式", storageType)}
              ${infoRow("认证模式", authMode)}
            </div>
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
        LocalStore.remove(STORAGE_BASEURL);
        api.setBaseUrl("");
        AuthManager.reset();
        Router.navigate("server", {}, { replaceHistory: true });
        return;
      }
      if (action === "clear-records") {
        LocalLibrary.deletePlayRecord(null);
        showToast("已清空播放记录");
        return;
      }
      if (handleNavAction(action)) return;
    }
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
