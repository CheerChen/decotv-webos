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

  setInitialFocus(container, selector = ".focusable") {
    const first = container?.querySelector(selector);
    if (!first) return;
    container?.querySelectorAll(`${selector}.focused`).forEach((n) => n.classList.remove("focused"));
    first.classList.add("focused");
    first.focus();
  },

  moveFocusDirectional(container, direction, selector = ".focusable") {
    const list = Array.from(container?.querySelectorAll(selector) || [])
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    if (!list.length) return;

    const current = container?.querySelector(`${selector}.focused`) || list[0];
    if (!current.classList.contains("focused")) {
      list.forEach((node) => node.classList.remove("focused"));
      current.classList.add("focused");
      current.focus();
      return;
    }

    const currentRect = current.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;

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
        const primary = (direction === "up" || direction === "down")
          ? Math.abs(entry.dy) : Math.abs(entry.dx);
        const secondary = (direction === "up" || direction === "down")
          ? Math.abs(entry.dx) : Math.abs(entry.dy);
        const axisTolerance = (direction === "up" || direction === "down")
          ? Math.max(currentRect.width * 0.7, entry.rect.width * 0.7, 48)
          : Math.max(currentRect.height * 0.7, entry.rect.height * 0.7, 48);
        const aligned = secondary <= axisTolerance;
        return { ...entry, aligned, score: primary * 1000 + secondary };
      });

    const aligned = candidates.filter((e) => e.aligned).sort((a, b) => a.score - b.score);
    const sorted = candidates.slice().sort((a, b) => a.score - b.score);
    const target = aligned[0]?.node || sorted[0]?.node || null;
    if (!target) return;

    current.classList.remove("focused");
    target.classList.add("focused");
    target.focus();
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
