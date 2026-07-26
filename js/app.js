// app.js — entry point. Wires router, focus engine, auth state machine.

import { Router } from "./ui/navigation/router.js";
import { FocusEngine } from "./ui/navigation/focusEngine.js";
import { AuthManager, AuthState } from "./core/auth/authManager.js";
import { api } from "./core/network/decotvClient.js";
import { LocalLibrary, SCHEMA_VERSION } from "./core/storage/localLibrary.js";

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
  // One-time migration: old versions stored play records per-source; the new
  // per-movie key scheme makes those entries orphans, so wipe them on first
  // launch of the new version.
  LocalLibrary.migrateRecordsIfNeeded();
  Router.init();
  FocusEngine.init(Router);

  // Global 401 handler — silently re-establish the session (real creds if we
  // have them, else anonymous). Does NOT navigate: a personal-endpoint 401 while
  // browsing anonymously must not bounce the user back to home.
  api.setUnauthorizedHandler(() => {
    AuthManager.ensureSession();
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
        break;
      case AuthState.ERROR:
        Router.navigate("server", { error: extra?.error || "未知错误" }, { replaceHistory: true });
        break;
    }
  });

  await AuthManager.bootstrap();
});
