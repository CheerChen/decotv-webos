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
export function handleNavAction(action) {
  const tab = NAV_TABS.find((entry) => entry.action === action);
  if (!tab) return false;
  // Always navigate — params may differ even when route is the same
  // (e.g. nav-movie and nav-tv both go to "search" with different type).
  Router.navigate(tab.route, tab.params);
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
