// focusEngine.js — D-pad + Back key handling for webOS remote.
// Adapted from NuvioTV-WebOS focusEngine (Apache-2.0). Simplified to a single
// `.focusable` + `data-action` pattern; zone/rail/panel patterns dropped.

import { handleDigitShortcut } from "./navHeader.js";

function isBackKey(event, normalizedCode) {
  const target = event?.target || null;
  const tagName = String(target?.tagName || "").toUpperCase();
  const isEditable = Boolean(
    target?.isContentEditable
    || tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT"
  );
  const key = String(event?.key || "");
  const keyLower = key.toLowerCase();
  const code = String(event?.code || "");
  const rawCode = Number(event?.keyCode || 0);

  if (isEditable && (key === "Backspace" || rawCode === 8 || key === "Delete" || rawCode === 46)) {
    return false;
  }
  if (normalizedCode === 461 || rawCode === 461) return true;
  if (
    key === "Escape" || key === "Esc" || key === "Backspace" || key === "GoBack" || key === "XF86Back"
    || code === "BrowserBack" || code === "GoBack"
  ) return true;
  if (keyLower.includes("back")) return true;
  if (rawCode === 27 || rawCode === 8 || rawCode === 10009) return true;
  return false;
}

function normalizeDirectionalKeyCode(code) {
  return code;
}

function buildNormalizedEvent(event) {
  const key = String(event?.key || "");
  const code = String(event?.code || "");
  const arrowFromKey = (() => {
    if (key === "ArrowUp" || key === "Up") return 38;
    if (key === "ArrowDown" || key === "Down") return 40;
    if (key === "ArrowLeft" || key === "Left") return 37;
    if (key === "ArrowRight" || key === "Right") return 39;
    return null;
  })();
  const rawCode = Number(arrowFromKey || event.keyCode || 0);
  const normalizedCode = normalizeDirectionalKeyCode(rawCode);
  return {
    key,
    code,
    target: event?.target || null,
    altKey: Boolean(event?.altKey),
    ctrlKey: Boolean(event?.ctrlKey),
    shiftKey: Boolean(event?.shiftKey),
    metaKey: Boolean(event?.metaKey),
    repeat: Boolean(event?.repeat),
    defaultPrevented: Boolean(event?.defaultPrevented),
    keyCode: normalizedCode,
    which: normalizedCode,
    originalKeyCode: rawCode,
    preventDefault: () => event?.preventDefault?.(),
    stopPropagation: () => event?.stopPropagation?.(),
    stopImmediatePropagation: () => event?.stopImmediatePropagation?.()
  };
}

function makeFakeEnterEvent() {
  return {
    key: "Enter",
    code: "Enter",
    target: null,
    altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false,
    defaultPrevented: false,
    keyCode: 13, which: 13, originalKeyCode: 13,
    preventDefault: () => {}, stopPropagation: () => {}, stopImmediatePropagation: () => {}
  };
}

function isNativeInputElement(el) {
  const tag = String(el?.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export const FocusEngine = {
  lastBackHandledAt: 0,
  router: null,

  init(router) {
    this.router = router;
    this.boundHandleKey = this.handleKey.bind(this);
    document.addEventListener("keydown", this.boundHandleKey, true);
    this.initClickSupport();
  },

  initClickSupport() {
    document.addEventListener("click", async (event) => {
      if (isNativeInputElement(event.target)) {
        event.target.focus();
        return;
      }
      const el = event.target.closest("[data-action], .focusable");
      if (!el) return;
      if (isNativeInputElement(el)) {
        el.focus();
        return;
      }
      const screen = this.router?.getCurrentScreen?.();
      if (!screen) return;
      const allFocusable = document.querySelectorAll(".focusable");
      allFocusable.forEach((node) => node.classList.remove("focused"));
      el.classList.add("focused");
      el.focus();
      if (typeof screen.onKeyDown === "function") {
        await screen.onKeyDown(makeFakeEnterEvent());
      }
    }, true);
  },

  handleKey(event) {
    if (event.defaultPrevented) return;
    const normalizedEvent = buildNormalizedEvent(event);

    if (isBackKey(event, normalizedEvent.keyCode)) {
      const now = Date.now();
      if (now - this.lastBackHandledAt < 180) return;
      this.lastBackHandledAt = now;
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      // Router.back() consults the screen's consumeBackRequest itself. Asking
      // here first meant every Back asked TWICE, which breaks screens whose
      // answer is stateful (a server-switch rollback consumed by the first
      // call made the second call look like a root-screen Back and exit).
      this.router?.back?.();
      return;
    }

    // Suppress synthetic click after Enter on remote — otherwise actions fire twice.
    const rawCode = Number(event?.keyCode || 0);
    if (rawCode === 13 || normalizedEvent.keyCode === 13) {
      event.preventDefault?.();
    }

    // Number-key shortcuts (0 = home, 1-9 = Douban content tabs). Only active
    // when the nav header is on screen, so the player and the first-run
    // screens (splash/server/login) are untouched; editable inputs are
    // filtered inside handleDigitShortcut so URL/credential typing survives.
    if (document.querySelector(".app-header") && handleDigitShortcut(event)) {
      return;
    }

    this.router?.getCurrentScreen?.()?.onKeyDown?.(normalizedEvent);
  }
};
