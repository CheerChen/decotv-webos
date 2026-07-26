// serverScreen.js — first-run / connect-fail server URL input.

import { ScreenUtils } from "../../navigation/screen.js";
import { AuthManager, AuthState } from "../../../core/auth/authManager.js";
import { showToast } from "../../toast.js";

export const ServerScreen = {
  container: null,
  error: "",
  connecting: false,

  async mount(params = {}) {
    this.container = document.getElementById("server");
    this.error = params.error || "";
    this.connecting = false;
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
          <p class="form-subtitle">输入服务端地址</p>
          <div class="form-row">
            <label class="form-label" for="serverUrlInput">服务器 URL</label>
            <input id="serverUrlInput" class="form-input focusable" type="text"
              autocomplete="off" spellcheck="false"
              placeholder="http://192.168.0.110:4000" />
          </div>
          <div class="form-error">${this.error}</div>
          <div class="form-actions">
            <button id="connectBtn" class="btn primary focusable" data-action="connect">连接</button>
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
    input.addEventListener("focus", () => {
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      input.classList.add("focused");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._doConnect(); }
    });

    btn.addEventListener("focus", () => {
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      btn.classList.add("focused");
    });
    btn.addEventListener("click", (e) => { e.preventDefault(); this._doConnect(); });
  },

  async _doConnect() {
    if (this.connecting) return;
    const input = this.container.querySelector("#serverUrlInput");
    let url = (input?.value || "").trim();
    if (!url) {
      this.error = "请输入服务器地址";
      this._render();
      this.container.querySelector("#serverUrlInput").focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    this._lastValue = url;
    this.connecting = true;
    this.error = "";
    const errEl = this.container.querySelector(".form-error");
    if (errEl) errEl.textContent = "连接中…";
    try {
      await AuthManager.connect(url);
    } catch (e) {
      this.error = String(e?.message || e);
      this.connecting = false;
      this._render();
      this.container.querySelector("#serverUrlInput").focus();
    }
  },

  // FocusEngine calls this for Enter on focused .focusable.
  async onKeyDown(event) {
    if (event.keyCode === 13) {
      const focused = this.container.querySelector(".focused");
      if (focused?.dataset?.action === "connect") {
        await this._doConnect();
      } else if (focused?.tagName === "INPUT") {
        await this._doConnect();
      }
    }
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
