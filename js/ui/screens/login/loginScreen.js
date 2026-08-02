// loginScreen.js — username/password login (multi-user storage mode).

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { AuthManager } from "../../../core/auth/authManager.js";
import { t } from "../../../core/i18n.js";

export const LoginScreen = {
  container: null,
  error: "",
  submitting: false,

  async mount(params = {}) {
    this.container = document.getElementById("login");
    this.error = params.error || "";
    this.submitting = false;
    this._render();
    ScreenUtils.show(this.container);
    const u = this.container.querySelector("#loginUserInput");
    if (u) u.focus();
  },

  _render() {
    const canSkip = AuthManager.canBrowseAnonymously();
    this.container.innerHTML = `
      <div class="center-wrap">
        <div class="form-card">
          <h1 class="form-title">${t("login.title")}</h1>
          <p class="form-subtitle">${t("login.subtitle")}</p>
          <div class="form-row">
            <label class="form-label" for="loginUserInput">${t("login.username")}</label>
            <input id="loginUserInput" class="form-input focusable" type="text"
              autocomplete="off" spellcheck="false" />
          </div>
          <div class="form-row">
            <label class="form-label" for="loginPassInput">${t("login.password")}</label>
            <input id="loginPassInput" class="form-input focusable" type="password"
              autocomplete="off" spellcheck="false" />
          </div>
          <div class="form-error">${this.error}</div>
          <div class="form-actions">
            <button id="loginBtn" class="btn primary focusable" data-action="login">${t("login.submit")}</button>
            ${canSkip ? `<button id="loginSkipBtn" class="btn ghost focusable" data-action="skip">${t("login.skip")}</button>` : ""}
          </div>
        </div>
      </div>
    `;
    this._bindActions();
  },

  _bindActions() {
    const u = this.container.querySelector("#loginUserInput");
    const p = this.container.querySelector("#loginPassInput");
    const btn = this.container.querySelector("#loginBtn");
    const skipBtn = this.container.querySelector("#loginSkipBtn");
    if (skipBtn) {
      skipBtn.addEventListener("focus", () => {
        this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
        skipBtn.classList.add("focused");
      });
      skipBtn.addEventListener("click", (e) => { e.preventDefault(); AuthManager.skipLogin(); });
    }

    [u, p, btn].forEach((el) => {
      el.addEventListener("focus", () => {
        this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
        el.classList.add("focused");
      });
    });
    [u, p].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._doLogin(); }
      });
    });
    btn.addEventListener("click", (e) => { e.preventDefault(); this._doLogin(); });
  },

  async _doLogin() {
    if (this.submitting) return;
    const u = this.container.querySelector("#loginUserInput")?.value || "";
    const p = this.container.querySelector("#loginPassInput")?.value || "";
    this.submitting = true;
    this.error = "";
    const errEl = this.container.querySelector(".form-error");
    if (errEl) errEl.textContent = t("login.submitting");
    try {
      await AuthManager.loginWithCredentials(u, p);
    } catch (e) {
      this.error = String(e?.message || e);
      this.submitting = false;
      this._render();
      this.container.querySelector("#loginUserInput").focus();
    }
  },

  async onKeyDown(event) {
    // D-pad moves across username/password/submit/skip; without this the
    // remote could not move focus at all (only the pointer worked).
    if (ScreenUtils.handleDpadNavigation(event, this.container)) return;
    if (event.keyCode === 13) {
      const focused = this.container.querySelector(".focused");
      if (focused?.dataset?.action === "skip") { await AuthManager.skipLogin(); return; }
      if (focused?.dataset?.action === "login" || focused?.tagName === "INPUT") {
        await this._doLogin();
      }
    }
  },

  // Back during a server switch rolls the working session back and lets the
  // router return to settings. Otherwise Back steps up the gate hierarchy:
  // credentials → server screen (prefilled with the current address). The
  // server screen is the root that exits the app.
  consumeBackRequest() {
    if (AuthManager.abortServerSwitch()) return false;
    Router.navigate("server", {}, { replaceHistory: true });
    return true;
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
