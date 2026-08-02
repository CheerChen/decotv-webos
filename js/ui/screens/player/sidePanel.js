// sidePanel.js — shared player side-panel rendering and focus setup.

import { escapeAttr, escapeHtml } from "../../utils.js";
import { ScreenUtils } from "../../navigation/screen.js";

export function createSidePanel({ id, title, hint, listId, items = [] }) {
  const panel = document.createElement("div");
  panel.id = id;
  panel.className = "player-side-panel";
  panel.innerHTML = `
    <div class="player-side-panel-header">
      <div class="player-side-panel-title">${escapeHtml(title)}</div>
      <button class="player-side-panel-close focusable" data-panel-close="1">关闭</button>
    </div>
    <div class="player-side-panel-hint">${escapeHtml(hint)}</div>
    <div class="player-side-panel-list" id="${escapeAttr(listId)}">
      ${items.map((item) => {
        const attrs = Object.entries(item.attrs || {})
          .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
          .join("");
        const selected = item.selected ? " selected" : "";
        const sub = item.subHtml
          ? `<div class="player-side-item-sub">${item.subHtml}</div>`
          : item.sub
            ? `<div class="player-side-item-sub">${escapeHtml(item.sub)}</div>`
            : "";
        return `
          <div class="player-side-item${selected} focusable"${attrs}>
            <div class="player-side-item-label">${escapeHtml(item.label)}</div>
            ${sub}
          </div>
        `;
      }).join("")}
    </div>
  `;
  return panel;
}

export function focusSidePanelItem(panel, selector) {
  const target = panel.querySelector(selector) || panel.querySelector(".player-side-item");
  if (!target) return;
  ScreenUtils.setFocus(target, panel);
  target.scrollIntoView?.({ block: "center" });
}
