// screen.js — focus movement + show/hide helpers shared by all screens.
// Geometry-based D-pad navigation adapted from NuvioTV-WebOS screen.js (Apache-2.0).

export const ScreenUtils = {

  show(container) {
    if (!container) return;
    container.style.opacity = "0";
    container.style.transition = "";
    container.style.display = "block";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.style.transition = "opacity 200ms ease";
        container.style.opacity = "1";
        const onEnd = () => {
          container.style.transition = "";
          container?.removeEventListener("transitionend", onEnd);
        };
        container.addEventListener("transitionend", onEnd);
      });
    });
  },

  hide(container) {
    if (!container) return;
    container.style.display = "none";
    container.innerHTML = "";
  },

  setFocus(target, scope = null) {
    if (!target) return null;
    const root = scope || target.closest?.(".screen") || target.parentElement || target.ownerDocument;
    root.querySelectorAll?.(".focused").forEach((node) => node.classList.remove("focused"));
    target.classList.add("focused");
    target.focus?.();
    return target;
  },

  focusMarker(node) {
    return node
      ? `${node.dataset.action || ""}|${node.dataset.key || ""}|${node.dataset.title || ""}|${node.dataset.row || ""}|${node.dataset.col || ""}`
      : "";
  },

  // Accept either a container (search descendants) or the focusable node itself.
  // Always clear other .focused nodes in the same .screen so querySelector
  // (".focused") cannot stick on a tab chip while a card also looks focused.
  setInitialFocus(targetOrRoot, selector = ".focusable") {
    if (!targetOrRoot) return;
    let first = null;
    try {
      if (typeof targetOrRoot.matches === "function" && targetOrRoot.matches(selector)) {
        first = targetOrRoot;
      }
    } catch (_) { /* invalid selector — fall through to query */ }
    if (!first) first = targetOrRoot.querySelector?.(selector) || null;
    if (!first) return;

    const scope = first.closest?.(".screen") || targetOrRoot.closest?.(".screen") || targetOrRoot;
    this.setFocus(first, scope);

  },

  moveFocusDirectional(container, direction, selector = ".focusable") {
    const list = Array.from(container?.querySelectorAll(selector) || [])
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    if (!list.length) return;

    // Prefer the focused node that is still in the visible list. If several
    // nodes still carry .focused (stale), pick the last one in list order so a
    // content card wins over an earlier header/tab chip.
    const focusedInList = list.filter((n) => n.classList.contains("focused"));
    const current = focusedInList.length ? focusedInList[focusedInList.length - 1] : list[0];
    if (focusedInList.length !== 1) {
      this.setFocus(current, container);
      if (focusedInList.length === 0) return; // just established focus; wait for next key
    }

    const currentRect = current.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;
    const horizontal = direction === "left" || direction === "right";

    const candidates = list
      .filter((node) => node !== current)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const nx = rect.left + rect.width / 2;
        const ny = rect.top + rect.height / 2;
        return { node, rect, dx: nx - cx, dy: ny - cy };
      })
      .filter(({ dx, dy }) => {
        if (direction === "up") return dy < -2;
        if (direction === "down") return dy > 2;
        if (direction === "left") return dx < -2;
        if (direction === "right") return dx > 2;
        return false;
      })
      .map((entry) => {
        const primary = horizontal ? Math.abs(entry.dx) : Math.abs(entry.dy);
        const secondary = horizontal ? Math.abs(entry.dy) : Math.abs(entry.dx);
        // Horizontal: tight vertical band so a short chip above a poster grid
        // cannot steal left/right moves between cards (old 0.7*cardHeight was
        // ~250px and treated the tab row as "aligned").
        // Vertical: keep a generous width band for irregular poster rows.
        const axisTolerance = horizontal
          ? Math.max(Math.min(currentRect.height, entry.rect.height) * 0.45, 36)
          : Math.max(currentRect.width * 0.7, entry.rect.width * 0.7, 48);
        const aligned = secondary <= axisTolerance;
        // Heavy penalty for off-axis candidates so fallback rarely jumps rows.
        const score = aligned
          ? primary * 1000 + secondary
          : primary * 1000 + secondary + 1_000_000;
        return { ...entry, aligned, score };
      });

    const aligned = candidates.filter((e) => e.aligned).sort((a, b) => a.score - b.score);
    const sorted = candidates.slice().sort((a, b) => a.score - b.score);
    const target = aligned[0]?.node || sorted[0]?.node || null;
    if (!target) return;

    this.setFocus(target, container);
    target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  },

  handleDpadNavigation(event, container, selector = ".focusable") {
    const code = Number(event?.keyCode || 0);
    const direction = code === 38 ? "up"
      : code === 40 ? "down"
        : code === 37 ? "left"
          : code === 39 ? "right"
            : null;
    if (!direction) return false;
    event.preventDefault?.();
    this.moveFocusDirectional(container, direction, selector);
    return true;
  },

  indexFocusables(container, selector = ".focusable") {
    const list = Array.from(container?.querySelectorAll(selector) || []);
    list.forEach((node, index) => {
      node.dataset.index = String(index);
      node.tabIndex = 0;
    });
  }
};
