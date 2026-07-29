// splashScreen.js — transient loading screen.

import { ScreenUtils } from "../../navigation/screen.js";
import { t } from "../../../core/i18n.js";

export const SplashScreen = {
  container: null,

  async mount() {
    this.container = document.getElementById("splash");
    // Mirror the webOS splashBackground (assets/splash.png) so there is no
    // visual jump between the native launch image and the first in-app frame.
    this.container.innerHTML = `
      <div class="center-wrap splash-wrap">
        <div class="splash-mark">
          <div class="splash-ring"></div>
          <div class="splash-d">D</div>
        </div>
        <div class="splash-word"><span>Deco</span><span class="splash-word-tv">TV</span></div>
        <div class="splash-status">${t("splash.connecting")}</div>
      </div>
    `;
    ScreenUtils.show(this.container);
  },

  setStatus(text) {
    const el = this.container?.querySelector(".splash-status");
    if (el) el.textContent = text;
  },

  cleanup() {
    ScreenUtils.hide(this.container);
  }
};
