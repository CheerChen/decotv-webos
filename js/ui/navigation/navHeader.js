// navHeader.js — shared nav header rendering + action dispatch.
// Extracted from 5 duplicate copies across home/search/detail/library/settings.

import { Router } from "./router.js";
import { t } from "../../core/i18n.js";

// Tab definitions: data-action → route + params. Tabs carry a labelKey rather
// than a label because this table is built once at import time — resolving the
// string here would freeze it to whatever language was active at startup.
// params.type is an ASCII slug, so it is never translated.
const NAV_TABS = [
  { action: "nav-home", labelKey: "nav.home", route: "home", params: {} },
  { action: "nav-hot-movie", labelKey: "nav.hotMovie", route: "search", params: { type: "hot-movie" } },
  { action: "nav-movie", labelKey: "nav.movie", route: "search", params: { type: "movie" } },
  { action: "nav-hot-tv", labelKey: "nav.hotTv", route: "search", params: { type: "hot-tv" } },
  { action: "nav-tv", labelKey: "nav.tv", route: "search", params: { type: "tv" } },
  { action: "nav-hot-anime", labelKey: "nav.hotAnime", route: "search", params: { type: "hot-anime" } },
  { action: "nav-anime", labelKey: "nav.anime", route: "search", params: { type: "anime" } },
  { action: "nav-hot-show", labelKey: "nav.hotShow", route: "search", params: { type: "hot-show" } },
  { action: "nav-show", labelKey: "nav.show", route: "search", params: { type: "show" } },
  { action: "nav-documentary", labelKey: "nav.documentary", route: "search", params: { type: "documentary" } },
  { action: "nav-library", labelKey: "nav.library", route: "library", params: {} },
  { action: "nav-settings", labelKey: "nav.settings", route: "settings", params: {} },
];

// Number-key shortcuts for the Douban content tabs. Keys 1-9 map to the nine
// content tabs in NAV_TABS order (home / library / settings are intentionally
// excluded — they are not Douban tag pages). Key 0 is home. Edit both tables
// together when the content tab order changes.
const DIGIT_TABS = [
  "nav-hot-movie",
  "nav-movie",
  "nav-hot-tv",
  "nav-tv",
  "nav-hot-anime",
  "nav-anime",
  "nav-hot-show",
  "nav-show",
  "nav-documentary",
];

// Handle a 0-9 digit key as a nav shortcut. 0 → home; 1-9 → Douban content
// tabs. Always asks the destination screen to land focus on the first content
// item (first poster card), not the filter chips or nav tab. Invoked from
// FocusEngine before the screen sees the key.
//
// Must NOT fire while typing in an input (server URL / login credentials), so
// editable targets are passed through untouched.
export function handleDigitShortcut(event) {
  const target = event?.target || null;
  const tagName = String(target?.tagName || "").toUpperCase();
  if (
    target?.isContentEditable
    || tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT"
  ) {
    return false;
  }
  const key = String(event?.key || "");
  let digit = null;
  if (key >= "0" && key <= "9") {
    digit = Number(key);
  } else {
    const code = Number(event?.keyCode || 0);
    if (code >= 48 && code <= 57) digit = code - 48;
  }
  if (digit === null) return false;
  const action = digit === 0 ? "nav-home" : DIGIT_TABS[digit - 1];
  if (!action) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();
  // Digit shortcuts always pin focus to the first cover so the user can OK
  // immediately without walking down from the filter row / nav bar.
  handleNavAction(action, { focusFirstItem: true });
  return true;
}

// Render the nav header HTML. activeTab is the data-action of the current tab.
export function renderNavHeader(activeTab = "") {
  const tabs = NAV_TABS.map((tab) => {
    const cls = tab.action === activeTab ? " active" : "";
    return `<div class="nav-tab focusable${cls}" data-action="${tab.action}">${t(tab.labelKey)}</div>`;
  }).join("");
  return `<div class="app-header"><div class="brand">DecoTV</div><div class="nav-tabs">${tabs}</div></div>`;
}

// Handle a nav-* action. Returns true if the action was a nav tab, false otherwise.
// Called from screen.onKeyDown when action starts with "nav-".
// options.focusFirstItem asks the destination screen to land focus on the
// first poster/content card once it is rendered (used by digit shortcuts).
export function handleNavAction(action, options = {}) {
  const tab = NAV_TABS.find((entry) => entry.action === action);
  if (!tab) return false;
  // Always navigate — params may differ even when route is the same
  // (e.g. nav-movie and nav-tv both go to "search" with different type).
  const params = { ...tab.params };
  if (options.focusFirstItem) params.focusFirstItem = true;
  Router.navigate(tab.route, params);
  return true;
}

// Bind click handlers on nav tabs within a container.
// (For mouse/touch — TV remote OK is handled by onKeyDown → handleNavAction.)
export function bindNavClicks(container) {
  container?.querySelectorAll('.nav-tab[data-action^="nav-"]').forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      handleNavAction(tab.dataset.action);
    });
  });
}
