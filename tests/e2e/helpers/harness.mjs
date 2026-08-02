// tests/e2e/helpers/harness.mjs — boot the app in Chromium with a fake backend.
import { CATALOG, PROBES, RESOLVE_FAILS, HOME_MOVIE_CARDS, SERVER_CONFIG } from "../fixtures/data.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// Boots to home with a seeded anonymous session and a fully faked backend.
// Returns a state object with collected page errors and per-endpoint call logs.
export async function bootToHome(page) {
  const state = { errors: [], searchCalls: [], resolveCalls: [], probeCalls: [] };
  page.on("pageerror", (err) => state.errors.push(String(err)));

  // 1) Kill webOSTV.js — otherwise window.webOS exists and every API call
  //    dies inside the Luna transport ("PalmServiceBridge is not found").
  await page.route("**/webOSTVjs-1.2.12/*.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "// stubbed for e2e" })
  );

  // 2) Block the one external request the app makes (search anime tab).
  await page.route("https://api.bgm.tv/**", (route) => route.abort());

  // 3) Fake the entire decotv API.
  await page.route("**/api/**", (route) => handleApi(route, state));

  // 4) Seed "server configured + anonymous public session".
  //    LocalStore JSON-stringifies every value, plain strings included.
  await page.addInitScript(({ config }) => {
    localStorage.setItem("decotv.apiBaseUrl", JSON.stringify("http://127.0.0.1:4173"));
    localStorage.setItem("decotv.serverConfig", JSON.stringify(config));
    localStorage.setItem("decotv.local.playRecords.migratedVersion", JSON.stringify("2"));
    localStorage.setItem("decotv.lang", JSON.stringify("zh-CN"));
  }, { config: SERVER_CONFIG });

  await page.goto("/index.html");
  await page.waitForFunction(
    () => window.__router?.current === "home" && document.querySelector("#home .poster-card.focused") !== null,
    null,
    { timeout: 15000 }
  );
  // Let the remaining home rows land: #homeScroll is rebuilt wholesale on
  // every row arrival, so interact only after the churn settles.
  await page.waitForTimeout(300);
  return state;
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function handleApi(route, state) {
  const u = new URL(route.request().url());
  const p = u.pathname;

  if (p === "/api/login") return json(route, { ok: true });
  if (p === "/api/logout") return json(route, { ok: true });
  if (p === "/api/server-config") return json(route, SERVER_CONFIG);
  if (p === "/api/image-proxy") {
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 });
  }
  if (p === "/api/douban") {
    // Row 0 (热门电影) carries the test catalog; other rows stay empty.
    const isMovieChart = u.searchParams.get("type") === "movie";
    return json(route, { list: isMovieChart ? HOME_MOVIE_CARDS : [] });
  }
  if (p === "/api/douban/categories" || p === "/api/douban/recommends") {
    return json(route, { list: [] });
  }
  if (p === "/api/search") {
    const q = u.searchParams.get("q") || "";
    state.searchCalls.push(q);
    return json(route, { results: CATALOG.filter((r) => r.title === q) });
  }
  if (p === "/api/playback/probe") {
    const source = u.searchParams.get("source") || "";
    state.probeCalls.push(source);
    return json(
      route,
      PROBES[source] || { hasError: true, status: "failed", failureKind: "unknown", message: `no fixture probe for ${source}` }
    );
  }
  if (p === "/api/playback/resolve") {
    const source = u.searchParams.get("source") || "";
    state.resolveCalls.push(source);
    if (RESOLVE_FAILS.has(source)) return json(route, { error: "mock resolve failure" }, 500);
    return json(route, { playbackUrl: "http://127.0.0.1:4173/tests/e2e/assets/ep1.webm" });
  }
  if (p === "/api/detail") {
    const source = u.searchParams.get("source") || "";
    const id = u.searchParams.get("id") || "";
    const hit = CATALOG.find((r) => r.source === source && String(r.id) === id);
    // Best-effort endpoint: detailScreen swallows errors here anyway.
    return json(route, hit ? { episodes: hit.episodes, desc: "E2E mock description", year: hit.year } : {});
  }
  // favorites / playrecords / searchhistory / anything else: empty object is fine.
  return json(route, {});
}
