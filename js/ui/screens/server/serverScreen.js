// serverScreen.js — first-run / connect-fail server URL input.

import { ScreenUtils } from "../../navigation/screen.js";
import { AuthManager, AuthState } from "../../../core/auth/authManager.js";
import { api } from "../../../core/network/decotvClient.js";
import { showToast } from "../../toast.js";
import { t } from "../../../core/i18n.js";

export const ServerScreen = {
  container: null,
  error: "",
  connecting: false,

  async mount(params = {}) {
    this.container = document.getElementById("server");
    this.error = params.error || "";
    this.connecting = false;
    // When switching servers, start from the current address rather than an
    // empty field — the user is usually editing, not retyping.
    this._lastValue = api.getStoredBaseUrl() || this._lastValue || "";
    this._render();
    ScreenUtils.show(this.container);
    const input = this.container.querySelector("#serverUrlInput");
    if (input) input.focus();
  },

  _render() {
    this.container.innerHTML = `
      <div class="center-wrap">
        <div class="form-card">
          <h1 class="form-title">DecoTV</h1>
          <p class="form-subtitle">${t("server.subtitle")}</p>
          <div class="form-row">
            <label class="form-label" for="serverUrlInput">${t("server.urlLabel")}</label>
            <input id="serverUrlInput" class="form-input focusable" type="text"
              autocomplete="off" spellcheck="false"
              placeholder="http://192.168.0.110:4000" />
          </div>
          <div class="form-error">${this.error}</div>
          <div class="form-actions">
            <button id="connectBtn" class="btn primary focusable" data-action="connect">${t("server.connect")}</button>
          </div>
        </div>
      </div>
    `;
    this._bindActions();
  },

  _bindActions() {
    const input = this.container.querySelector("#serverUrlInput");
    const btn = this.container.querySelector("#connectBtn");

    // Pre-fill if a value was typed before re-render.
    if (this._lastValue) input.value = this._lastValue;
    input.addEventListener("input", () => { this._lastValue = input.value; });
    input.addEventListener("focus", () => ScreenUtils.setFocus(input, this.container));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._doConnect(); }
    });

    btn.addEventListener("focus", () => ScreenUtils.setFocus(btn, this.container));
    btn.addEventListener("click", (e) => { e.preventDefault(); this._doConnect(); });
  },

  async _doConnect() {
    if (this.connecting) return;
    const input = this.container.querySelector("#serverUrlInput");
    let url = (input?.value || "").trim();
    if (!url) {
      this.error = t("server.emptyUrl");
      this._render();
      this.container.querySelector("#serverUrlInput").focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    this._lastValue = url;
    this.connecting = true;
    this.error = "";
    const errEl = this.container.querySelector(".form-error");
    if (errEl) errEl.textContent = t("server.connecting");
    try {
      await AuthManager.connect(url);
    } catch (e) {
      this.error = String(e?.message || e);
      this.connecting = false;
      this._render();
      this.container.querySelector("#serverUrlInput").focus();
    }
  },

  async onKeyDown(event) {
    // D-pad moves between the URL input and the Connect button; without this
    // the remote could not move focus at all (only the pointer worked).
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    if (event.keyCode === 13) {
      const focused = this.container.querySelector(".focused");
      if (focused?.dataset?.action === "connect") {
        await this._doConnect();
      } else if (focused?.tagName === "INPUT") {
        await this._doConnect();
      }
    }
  },

  // Back during a server switch rolls the working session back and lets the
  // router return to settings. Outside a switch (first run / connect-fail)
  // this screen is the root: there is nothing meaningful behind it, so Back
  // exits the app instead of falling through to a serverless home screen.
  consumeBackRequest() {
    if (AuthManager.abortServerSwitch()) return false;
    if (window.webOSSystem) webOSSystem.close();
    return true;
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
