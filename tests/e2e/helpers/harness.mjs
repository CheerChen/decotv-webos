// tests/e2e/helpers/harness.mjs — boot the app in Chromium with a fake backend.
import { CATALOG, PROBES, RESOLVE_FAILS, RESOLVE_SLOW, HOME_MOVIE_CARDS, SERVER_CONFIG, DOUBAN_SUBJECT_1001, TMDB_TV_777 } from "../fixtures/data.mjs";

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

  // 2) Block Bangumi (anime tabs, home 热门动漫 row, Bangumi details).
  //    Specs that need it register their own routes after boot.
  await page.route("https://api.bgm.tv/**", (route) => route.abort());
  await page.route("https://next.bgm.tv/**", (route) => route.abort());

  // 3) Fake the entire decotv API.
  await page.route("**/api/**", (route) => handleApi(route, state));

  // 4) Seed "server configured + anonymous public session" and fake the
  //    Luna bus. LocalStore JSON-stringifies every value, plain strings
  //    included. The webOS.service.request stub is required because the
  //    Douban catalog no longer calls /api/douban* — it goes through the
  //    service's fetchDouban (rexxar, m.douban.com).
  await page.addInitScript(({ config, movieItems, pngB64, doubanSubject, tmdbTv }) => {
    localStorage.setItem("decotv.apiBaseUrl", JSON.stringify("http://127.0.0.1:4173"));
    localStorage.setItem("decotv.serverConfig", JSON.stringify(config));
    localStorage.setItem("decotv.local.playRecords.migratedVersion", JSON.stringify("2"));
    localStorage.setItem("decotv.lang", JSON.stringify("zh-CN"));

    const CANCEL = { cancel() {} };
    window.webOS = {
      service: {
        request(_uri, options) {
          const p = options.parameters || {};
          const ok = (r) => options.onSuccess(r);
          const fail = (e) => options.onFailure({ errorText: String(e) });

          if (options.method === "request") {
            // Authenticated API proxy — forward to fetch so the **/api/**
            // route mocks above still serve it.
            fetch(new URL(p.path, p.baseUrl).href, {
              method: p.method || "GET",
              headers: p.contentType ? { "Content-Type": p.contentType } : undefined,
              body: p.body || undefined,
            }).then(async (res) => ok({
              returnValue: true,
              status: res.status,
              contentType: res.headers.get("content-type") || "",
              body: await res.text(),
            })).catch(fail);
            return CANCEL;
          }
          if (options.method === "fetchDouban") {
            const path = String(p.path || "");
            // Specs read this to check which rexxar calls were made.
            (window.__doubanPaths = window.__doubanPaths || []).push(path);
            let body;
            if (path.includes("/subject_collection/movie_hot_gaia")) {
              body = { total: movieItems.length, subject_collection_items: movieItems };
            } else if (path.includes("/subject_collection/")) {
              body = { total: 0, subject_collection_items: [] };
            } else if (path.includes("/subject/recent_hot/") || path.includes("/recommend")) {
              body = { total: 0, items: [] };
            } else if (/^\/rexxar\/api\/v2\/(movie|tv)\/\d+\/photos/.test(path)) {
              body = { total: 0, photos: [] };
            } else if (/^\/rexxar\/api\/v2\/(movie|tv)\/\d+$/.test(path)) {
              // Subject details: one fixture subject, everything else missing.
              const known = path.endsWith(`/${doubanSubject.id}`);
              ok({ returnValue: true, status: known ? 200 : 404, contentType: "application/json",
                body: JSON.stringify(known ? doubanSubject : { msg: "not found" }) });
              return CANCEL;
            } else {
              fail(`unhandled rexxar path: ${path}`);
              return CANCEL;
            }
            ok({ returnValue: true, status: 200, contentType: "application/json", body: JSON.stringify(body) });
            return CANCEL;
          }
          if (options.method === "fetchImage") {
            ok({ returnValue: true, base64: pngB64, contentType: "image/png", source: "proxy" });
            return CANCEL;
          }
          if (options.method === "diagnostics") {
            ok({ returnValue: true, hasSession: false, cookieKeys: [], images: null });
            return CANCEL;
          }
          if (options.method === "clearSession") { ok({ returnValue: true }); return CANCEL; }
          if (options.method === "getM3u8ProxyPort") {
            ok({ returnValue: true, ready: false, port: 0 });
            return CANCEL;
          }
          if (options.method === "fetchTmdb") {
            // One TMDB tv work (details + season 1); every other path fails.
            const path = new URL(String(p.path || ""), "https://api.themoviedb.org").pathname;
            const body = path === `/3/tv/${tmdbTv.details.id}` ? tmdbTv.details
              : path === `/3/tv/${tmdbTv.details.id}/season/1` ? tmdbTv.season1
              : null;
            if (body) {
              ok({ returnValue: true, status: 200, contentType: "application/json", body: JSON.stringify(body) });
              return CANCEL;
            }
            fail("no such TMDB fixture");
            return CANCEL;
          }
          fail(`unhandled luna method: ${options.method}`);
          return CANCEL;
        },
      },
    };
  }, {
    config: SERVER_CONFIG,
    pngB64: PNG_1X1.toString("base64"),
    doubanSubject: DOUBAN_SUBJECT_1001,
    tmdbTv: TMDB_TV_777,
    // rexxar subject_collection item shape: cover.url (no pic), year inside
    // card_subtitle, rating.value + rating.count.
    movieItems: HOME_MOVIE_CARDS.map((c) => ({
      id: c.id,
      title: c.title,
      type: "movie",
      cover: { url: c.poster },
      rating: { value: Number(c.rate), count: 12345 },
      card_subtitle: `${c.year} / e2e`,
    })),
  });

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

async function handleApi(route, state) {
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
    const slow = RESOLVE_SLOW[source];
    if (slow) {
      await new Promise((r) => setTimeout(r, slow.delayMs));
      return json(route, { playbackUrl: slow.playbackUrl });
    }
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
