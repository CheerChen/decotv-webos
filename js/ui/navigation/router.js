// router.js — minimal SPA router with self-maintained back stack.
//
// Browser history is used ONLY as a Back-key interceptor: on init we push a
// sentinel entry, and on popstate we immediately pushState back (so the
// sentinel stays) and delegate to this.back(). Route/params are never mirrored
// into history state — this.stack is the single source of truth.

const NON_BACKSTACK_ROUTES = new Set(["splash", "server", "login"]);

export const Router = {
  current: null,
  currentParams: {},
  stack: [],
  routes: {},

  register(name, screen) {
    this.routes[name] = screen;
  },

  init() {
    // Push a sentinel history entry so hardware Back triggers popstate
    // instead of exiting the app immediately. On popstate, re-push the
    // sentinel and delegate to back() — never trust event.state.
    if (window?.history && typeof window.history.pushState === "function") {
      window.history.pushState({ sentinel: true }, "");
      window.addEventListener("popstate", () => {
        // Re-push sentinel so future Back keys still trigger popstate.
        window.history.pushState({ sentinel: true }, "");
        // Delegate to our back() — the single source of truth.
        const currentScreen = this.routes[this.current];
        if (currentScreen?.consumeBackRequest?.()) return;
        this.back();
      });
    }
  },

  getCurrentScreen() {
    return this.routes[this.current] || null;
  },

  async navigate(routeName, params = {}, options = {}) {
    const fromHistory = Boolean(options?.fromHistory);
    const skipStackPush = Boolean(options?.skipStackPush);
    const replaceHistory = Boolean(options?.replaceHistory);

    const Screen = this.routes[routeName];
    if (!Screen) {
      console.error("Route not found:", routeName);
      return;
    }

    const previousRoute = this.current;
    const shouldSkipPush = skipStackPush || (previousRoute && NON_BACKSTACK_ROUTES.has(previousRoute));
    if (this.current && this.current !== routeName) {
      this.routes[this.current]?.cleanup?.();
      if (!shouldSkipPush) {
        this.stack.push({ route: this.current, params: this.currentParams || {} });
      }
    } else if (this.current === routeName) {
      this.routes[this.current]?.cleanup?.();
    }

    this.current = routeName;
    this.currentParams = params || {};

    await Screen.mount(this.currentParams, { fromHistory });
  },

  async back() {
    const currentScreen = this.routes[this.current];
    if (currentScreen?.consumeBackRequest?.()) return;

    if (this.current === "home") {
      if (window.webOSSystem) webOSSystem.close();
      return;
    }

    // this.stack is the single source of truth — pop directly.
    if (this.stack.length > 0) {
      const previous = this.stack.pop();
      const previousRoute = typeof previous === "string" ? previous : previous?.route;
      const previousParams = typeof previous === "string" ? {} : (previous?.params || {});
      if (!previousRoute || !this.routes[previousRoute]) return;

      this.routes[this.current]?.cleanup?.();
      this.current = previousRoute;
      this.currentParams = previousParams;
      await this.routes[previousRoute].mount(previousParams, { fromHistory: true });
      return;
    }

    // Stack empty — fall back to home, then close.
    if (this.current && this.current !== "home" && this.routes.home) {
      this.routes[this.current]?.cleanup?.();
      this.current = "home";
      this.currentParams = {};
      await this.routes.home.mount();
      return;
    }
    if (window.webOSSystem) webOSSystem.close();
  }
};
