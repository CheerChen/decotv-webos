// app.js — entry point. Wires router, focus engine, auth state machine.

import { Router } from "./ui/navigation/router.js";
import { FocusEngine } from "./ui/navigation/focusEngine.js";
import { AuthManager, AuthState } from "./core/auth/authManager.js";
import { api } from "./core/network/decotvClient.js";
import { LocalLibrary, SCHEMA_VERSION } from "./core/storage/localLibrary.js";
import { LibrarySync } from "./core/storage/librarySync.js";
import { t, applyDocumentLang } from "./core/i18n.js";
import { watchPosters } from "./ui/posterImage.js";

import { SplashScreen } from "./ui/screens/splash/splashScreen.js";
import { ServerScreen } from "./ui/screens/server/serverScreen.js";
import { LoginScreen } from "./ui/screens/login/loginScreen.js";
import { HomeScreen } from "./ui/screens/home/homeScreen.js";
import { SearchScreen } from "./ui/screens/search/searchScreen.js";
import { DetailScreen } from "./ui/screens/detail/detailScreen.js";
import { LibraryScreen } from "./ui/screens/library/libraryScreen.js";
import { SettingsScreen } from "./ui/screens/settings/settingsScreen.js";
import { PlayerScreen } from "./ui/screens/player/playerScreen.js";

Router.register("splash", SplashScreen);
Router.register("server", ServerScreen);
Router.register("login", LoginScreen);
Router.register("home", HomeScreen);
Router.register("search", SearchScreen);
Router.register("detail", DetailScreen);
Router.register("library", LibraryScreen);
Router.register("settings", SettingsScreen);
Router.register("player", PlayerScreen);

document.addEventListener("DOMContentLoaded", async () => {
  console.log("DecoTV webOS starting...");
  // Set <html lang> before the first screen renders so the webview picks the
  // right font fallback from the very first frame.
  applyDocumentLang();
  // One-time migration: old versions stored play records per-source; the new
  // per-movie key scheme makes those entries orphans, so wipe them on first
  // launch of the new version.
  LocalLibrary.migrateRecordsIfNeeded();
  Router.init();
  FocusEngine.init(Router);
  // Posters are fetched by the JS service and swapped in as they arrive; see
  // posterImage.js for why the webview cannot load them itself.
  watchPosters();
  // CDP live-debug / screenshot helpers (window is file:// origin on device).
  window.__router = Router;
  window.__focusEngine = FocusEngine;

  // Global 401 handler — silently re-establish the session (real creds if we
  // have them, else anonymous). Does NOT navigate: a personal-endpoint 401 while
  // browsing anonymously must not bounce the user back to home.
  api.setUnauthorizedHandler(() => {
    AuthManager.ensureSession();
  });

  // Library mirroring is tied to having a real account: anonymous browsing on a
  // public server has no server-side library to sync with, and every call would
  // 401. isLoggedIn is passed as a callback rather than imported inside
  // librarySync so that module stays free of auth state and unit-testable.
  LibrarySync.configure({
    api,
    isEnabled: () => AuthManager.isLoggedIn(),
    onPulled: () => Router.getCurrentScreen()?.refreshLibraryData?.()
  });

  AuthManager.subscribe((state, extra) => {
    switch (state) {
      case AuthState.LOADING:
        if (Router.current !== "splash") Router.navigate("splash", {}, { replaceHistory: true });
        break;
      case AuthState.NEED_SERVER:
        Router.navigate("server", { error: extra?.error || "" }, { replaceHistory: true });
        break;
      case AuthState.NEED_LOGIN:
        Router.navigate("login", { error: extra?.error || "" }, { replaceHistory: true });
        break;
      case AuthState.AUTHENTICATED:
        Router.navigate("home", {}, { replaceHistory: true });
        // Not awaited: home renders its "continue watching" row from the local
        // store straight away and refreshes it if the pull changes anything.
        // Blocking the first paint on two API calls to save a re-render would
        // be a poor trade.
        LibrarySync.pull();
        break;
      case AuthState.ERROR:
        Router.navigate("server", { error: extra?.error || t("app.unknownError") }, { replaceHistory: true });
        break;
    }
  });

  await AuthManager.bootstrap();
});
