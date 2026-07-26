// router.js — minimal SPA router with history stack, adapted from NuvioTV-WebOS.

const NON_BACKSTACK_ROUTES = new Set(["splash", "server", "login"]);

export const Router = {
  current: null,
  currentParams: {},
  stack: [],
  historyInitialized: false,
  routes: {},

  register(name, screen) {
    this.routes[name] = screen;
  },

  init() {
    // popstate fires when the browser/webview itself navigates back (e.g. the
    // webOS remote's Back key sometimes bypasses FocusEngine and triggers a
    // native history.back()). We no longer trust event.state — the browser
    // history stack drifts from this.stack (pushState runs after async mount,
    // replaceState overwrites entries). Delegate everything to back(), which
    // pops the self-maintained stack — the single source of truth.
    window.addEventListener("popstate", async () => {
      const currentScreen = this.routes[this.current];
      if (currentScreen?.consumeBackRequest?.()) {
        // Screen consumed the back (e.g. closed a panel). Restore the history
        // entry so a future back still targets the current route.
        if (window?.history && typeof window.history.pushState === "function") {
          window.history.pushState({ route: this.current, params: this.currentParams }, "");
        }
        return;
      }
      await this.back();
    });
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
    window.__currentScreen = Screen;
    window.__router = this;

    await Screen.mount(this.currentParams, { fromHistory });

    if (window?.history && typeof window.history.pushState === "function") {
      const state = { route: this.current, params: this.currentParams };
      if (!this.historyInitialized) {
        window.history.replaceState(state, "");
        this.historyInitialized = true;
      } else if (!fromHistory) {
        if (replaceHistory || (previousRoute && NON_BACKSTACK_ROUTES.has(previousRoute))) {
          window.history.replaceState(state, "");
        } else {
          window.history.pushState(state, "");
        }
      }
    }
  },

  async back() {
    const currentScreen = this.routes[this.current];
    if (currentScreen?.consumeBackRequest?.()) return;

    if (this.current === "home") {
      if (window.webOSSystem) webOSSystem.close();
      return;
    }

    // Prefer the self-maintained stack over window.history.back().
    // The browser history stack drifts out of sync with this.stack because
    // pushState runs AFTER async mount() completes, and replaceState calls
    // (NON_BACKSTACK routes) overwrite entries — so history.back() can land
    // on the wrong state (e.g. home instead of detail). this.stack is the
    // source of truth we explicitly push in navigate(), so pop it directly.
    if (this.stack.length > 0) {
      const previous = this.stack.pop();
      const previousRoute = typeof previous === "string" ? previous : previous?.route;
      const previousParams = typeof previous === "string" ? {} : (previous?.params || {});
      if (!previousRoute || !this.routes[previousRoute]) return;

      this.routes[this.current]?.cleanup?.();
      this.current = previousRoute;
      this.currentParams = previousParams;
      window.__currentScreen = this.routes[previousRoute];
      await this.routes[previousRoute].mount(previousParams, { fromHistory: true });

      // Keep browser history roughly in sync: replace the current entry
      // with the target route so a later hardware-back / popstate doesn't
      // re-trigger a stale state. Do NOT pushState — we already popped.
      if (window?.history && typeof window.history.replaceState === "function") {
        window.history.replaceState({ route: this.current, params: this.currentParams }, "");
      }
      return;
    }

    // Stack empty — fall back to home, then close.
    if (this.current && this.current !== "home" && this.routes.home) {
      this.routes[this.current]?.cleanup?.();
      this.current = "home";
      this.currentParams = {};
      window.__currentScreen = this.routes.home;
      await this.routes.home.mount();
      if (window?.history && typeof window.history.replaceState === "function") {
        window.history.replaceState({ route: "home", params: {} }, "");
      }
      return;
    }
    if (window.webOSSystem) webOSSystem.close();
  }
};
