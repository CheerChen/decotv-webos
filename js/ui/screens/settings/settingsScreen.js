// settingsScreen.js — actions on the left, read-only info on the right.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { LibrarySync } from "../../../core/storage/librarySync.js";
import { showToast } from "../../toast.js";
import { renderNavHeader, bindNavClicks, handleNavAction } from "../../navigation/navHeader.js";
import { escapeHtml } from "../../utils.js";
import { t, setLang, nextLang } from "../../../core/i18n.js";

// Fallback when webOS.fetchAppInfo is unavailable (desktop / tests).
// Keep in sync with appinfo.json / package.json.
const CLIENT_VERSION_FALLBACK = "0.5.2";

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

  // params.focusAction re-focuses a specific row after a re-mount. The language
  // toggle re-mounts to re-render every string, and without this the focus
  // would jump back to the top of the list on each press.
  async mount(params = {}) {
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
            <div class="section-title">${t("settings.options")}</div>
            <div class="settings-list">
              <div class="settings-item focusable" data-action="toggle-lang">
                <div class="settings-label">${t("settings.language")}</div>
                <div class="settings-value">${escapeHtml(t("lang.self"))}</div>
              </div>
              <div class="settings-item focusable" data-action="change-server">
                <div class="settings-label">${t("settings.changeServer")}</div>
                <div class="settings-value">›</div>
              </div>
              <div class="settings-item focusable" data-action="clear-records">
                <div class="settings-label">${t("settings.clearRecords")}</div>
                <div class="settings-value">›</div>
              </div>
              ${AuthManager.hasAccountSession() ? `
              <div class="settings-item focusable" data-action="logout">
                <div class="settings-label">${t("settings.logout")}</div>
                <div class="settings-value">›</div>
              </div>` : ""}
            </div>
          </div>
          <div class="settings-col settings-col-info">
            <div class="section-title">${t("settings.deviceInfo")}</div>
            <div class="settings-list">
              ${infoRow(t("settings.appVersion"), clientVersion)}
              ${infoRow(t("settings.appId"), "com.cheerchen.decotv")}
            </div>
            <div class="section-title">${t("settings.serverInfo")}</div>
            <div class="settings-list">
              ${infoRow(t("settings.siteName"), siteName)}
              ${infoRow(t("settings.serverUrl"), baseUrl)}
              ${infoRow(t("settings.serverVersion"), serverVersion)}
              ${infoRow(t("settings.storageType"), storageType)}
              ${infoRow(t("settings.authMode"), authMode)}
            </div>
          </div>
        </div>
      </div>
    `;
    ScreenUtils.show(this.container);
    bindNavClicks(this.container);
    const focusAction = params.focusAction || "change-server";
    ScreenUtils.setInitialFocus(
      this.container.querySelector(`.settings-item[data-action="${focusAction}"]`)
      || this.container.querySelector('.settings-item[data-action="change-server"]')
    );
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    if (code === 13) {
      const focused = this.container.querySelector(".focused");
      if (!focused) return;
      const action = focused.dataset.action;
      if (action === "toggle-lang") {
        // Re-mount so every string on the screen re-renders in the new
        // language; navigate() with the current route just cleans up and
        // mounts again, so nothing is pushed onto the back stack.
        setLang(nextLang());
        Router.navigate("settings", { focusAction: "toggle-lang" });
        return;
      }
      if (action === "change-server") {
        // Non-destructive: the working session is snapshotted and only
        // replaced once a login on the new server completes. Backing out of
        // the server (or login) screen rolls back to it.
        AuthManager.beginServerSwitch();
        Router.navigate("server");
        return;
      }
      if (action === "logout") {
        await AuthManager.logout();
        return;
      }
      if (action === "clear-records") {
        LocalLibrary.deletePlayRecord(null);
        // Clear the server too, otherwise the next pull hands them all back.
        LibrarySync.clearRecords();
        showToast(t("settings.clearedRecords"));
        return;
      }
      if (handleNavAction(action)) return;
    }
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
