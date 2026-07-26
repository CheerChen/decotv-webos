// navHeader.js — shared nav header rendering + action dispatch.
// Extracted from 5 duplicate copies across home/search/detail/library/settings.

import { Router } from "./router.js";

// Tab definitions: data-action → route + params.
const NAV_TABS = [
  { action: "nav-home", label: "首页", route: "home", params: {} },
  { action: "nav-movie", label: "电影", route: "search", params: { type: "movie" } },
  { action: "nav-tv", label: "剧集", route: "search", params: { type: "tv" } },
  { action: "nav-anime", label: "动漫", route: "search", params: { type: "anime" } },
  { action: "nav-show", label: "综艺", route: "search", params: { type: "show" } },
  { action: "nav-library", label: "收藏", route: "library", params: {} },
  { action: "nav-settings", label: "设置", route: "settings", params: {} },
];

// Render the nav header HTML. activeTab is the data-action of the current tab.
export function renderNavHeader(activeTab = "") {
  const tabs = NAV_TABS.map((t) => {
    const cls = t.action === activeTab ? " active" : "";
    return `<div class="nav-tab focusable${cls}" data-action="${t.action}">${t.label}</div>`;
  }).join("");
  return `<div class="app-header"><div class="brand">DecoTV</div><div class="nav-tabs">${tabs}</div></div>`;
}

// Handle a nav-* action. Returns true if the action was a nav tab, false otherwise.
// Called from screen.onKeyDown when action starts with "nav-".
export function handleNavAction(action) {
  const tab = NAV_TABS.find((t) => t.action === action);
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
