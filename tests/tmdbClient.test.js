import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  TmdbClient,
  translateGenres,
  seriesBaseTitle,
  dedupeSeries,
  keepTrendingTv,
  pickPoster
} from "../js/core/network/tmdbClient.js";

// Minimal localStorage so LocalStore works under node.
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
  return map;
}

// Fake transport: records every requested path and answers from `route`.
function fakeTransport(route) {
  const calls = [];
  const transport = async (path) => {
    calls.push(path);
    const url = new URL(path, "https://api.themoviedb.org");
    const body = route(url);
    if (body instanceof Error) throw body;
    return JSON.stringify(body);
  };
  return { calls, transport };
}

function listCalls(calls) {
  return calls.filter((p) => !p.includes("/images"));
}

const noImages = () => ({ posters: [] });

describe("TMDB pure mapping helpers", () => {
  test("genre labels map to ids keeping AND/OR separators; raw ids pass through", () => {
    assert.equal(translateGenres("动作,喜剧"), "28,35");
    assert.equal(translateGenres("动作|喜剧"), "28|35");
    assert.equal(translateGenres("10764,99"), "10764,99");
    assert.equal(translateGenres("不存在"), "");
  });

  test("series base title strips sequel markers but keeps numeric titles", () => {
    assert.equal(seriesBaseTitle("某系列 2"), "某系列");
    assert.equal(seriesBaseTitle("某剧 第二季"), "某剧");
    assert.equal(seriesBaseTitle("标题：副标题"), "标题");
    assert.equal(seriesBaseTitle("1234"), "1234");
  });

  test("dedupeSeries keeps the highest-rated entry of a franchise", () => {
    const out = dedupeSeries([
      { title: "X 1", rate: "7.0" },
      { title: "X 2", rate: "8.1" },
      { title: "Y", rate: "6.0" }
    ]);
    assert.deepEqual(out.map((i) => i.title).sort(), ["X 2", "Y"]);
  });

  test("keepTrendingTv applies the vote floor, release date and genre exclusions", () => {
    const today = "2026-10-03";
    assert.equal(keepTrendingTv({ vote_count: 100, first_air_date: "2026-01-01", genre_ids: [18] }, today), true);
    assert.equal(keepTrendingTv({ vote_count: 6, first_air_date: "2026-01-01" }, today), false);
    assert.equal(keepTrendingTv({ vote_count: 500, first_air_date: "2027-05-01" }, today), false);
    assert.equal(keepTrendingTv({ vote_count: 500, first_air_date: "" }, today), true);
    // animation / talk show
    assert.equal(keepTrendingTv({ vote_count: 500, genre_ids: [16] }, today), false);
    assert.equal(keepTrendingTv({ vote_count: 500, genre_ids: [35, 10767] }, today), false);
  });

  test("pickPoster prefers the original language, highest vote", () => {
    const posters = [
      { iso_639_1: "en", file_path: "/en.jpg", vote_average: 9 },
      { iso_639_1: "ja", file_path: "/ja-low.jpg", vote_average: 2 },
      { iso_639_1: "ja", file_path: "/ja-high.jpg", vote_average: 5 }
    ];
    assert.equal(pickPoster(posters, "ja"), "/ja-high.jpg");
    assert.equal(pickPoster(posters, "ko"), "/en.jpg");
    assert.equal(pickPoster([], "ja"), "");
  });
});

describe("TmdbClient requests", () => {
  beforeEach(() => installStorage());

  test("movie hot is discover by popularity, last year, 100-vote floor", async () => {
    const { calls, transport } = fakeTransport((url) => {
      if (url.pathname.endsWith("/images")) {
        return { posters: [{ iso_639_1: "ja", file_path: "/loc.jpg", vote_average: 1 }] };
      }
      return {
        page: 1, total_pages: 3, total_results: 60,
        results: [{
          id: 7, title: "片名", vote_average: 8.25, vote_count: 1234,
          release_date: "2020-05-01", poster_path: "/p.jpg", original_language: "ja"
        }]
      };
    });
    const data = await new TmdbClient({ transport }).getChart("movie", "hot", 2);

    const first = new URL(calls[0], "https://api.themoviedb.org");
    const q = first.searchParams;
    assert.equal(first.pathname, "/3/discover/movie");
    assert.equal(q.get("language"), "zh-CN");
    assert.equal(q.get("sort_by"), "popularity.desc");
    assert.equal(q.get("vote_count.gte"), "100");
    assert.equal(q.get("page"), "2");
    const span = (Date.parse(q.get("primary_release_date.lte")) - Date.parse(q.get("primary_release_date.gte"))) / 86400000;
    assert.equal(span, 365);
    assert.equal(q.get("api_key"), null);
    assert.equal(data.total, 60);
    assert.deepEqual(data.list[0], {
      id: "7", title: "片名", poster: "https://image.tmdb.org/t/p/w500/loc.jpg",
      rate: "8.3", votes: 1234, year: "2020",
      _tmdb_id: 7, _media_type: "movie", _date: "2020-05-01"
    });
  });

  test("movie latest is theatrical releases of the last 45 days, 100-vote floor", async () => {
    const { calls, transport } = fakeTransport(() => ({ results: [] }));
    await new TmdbClient({ transport }).getChart("movie", "latest", 1);
    const q = new URL(calls[0], "https://api.themoviedb.org").searchParams;
    assert.equal(q.get("with_release_type"), "2|3");
    assert.equal(q.get("vote_count.gte"), "100");
    assert.equal(q.get("sort_by"), "popularity.desc");
    assert.equal((Date.parse(q.get("release_date.lte")) - Date.parse(q.get("release_date.gte"))) / 86400000, 45);
  });

  test("tv 欧美 is recent western discover with the floor and genre exclusions", async () => {
    const { calls, transport } = fakeTransport(() => ({ results: [] }));
    await new TmdbClient({ transport }).getChart("tv", "hot", 1, { region: "欧美" });
    const url = new URL(calls[0], "https://api.themoviedb.org");
    assert.equal(url.pathname, "/3/discover/tv");
    assert.equal(url.searchParams.get("vote_count.gte"), "100");
    assert.match(url.searchParams.get("with_origin_country"), /^US\|GB/);
    assert.equal(url.searchParams.get("without_genres"), "16,10767,10763,10764,10766");
  });

  test("tv 全部 pulls trending pages until 20 survivors and continues on page 2", async () => {
    // Each upstream page: 20 items, ids unique per page, 8 of them >= 100 votes.
    const { calls, transport } = fakeTransport((url) => {
      if (url.pathname.endsWith("/images")) return noImages();
      const p = Number(url.searchParams.get("page"));
      return {
        total_pages: 500, total_results: 10000,
        results: Array.from({ length: 20 }, (_, i) => ({
          id: p * 100 + i, name: `t${p}-${i}`, first_air_date: "2026-01-01",
          vote_count: i < 8 ? 150 : 6, genre_ids: [18]
        }))
      };
    });
    const client = new TmdbClient({ transport });
    const p1 = await client.getChart("tv", "hot", 1);
    assert.equal(new URL(listCalls(calls)[0], "https://api.themoviedb.org").pathname, "/3/trending/tv/week");
    assert.equal(p1.list.length, 20);
    assert.ok(p1.list.every((it) => it.votes >= 100));
    assert.equal(listCalls(calls).length, 3); // 8 + 8 + 8 >= 20
    // total estimate: 10000 * 24 kept / 60 scanned
    assert.equal(p1.total, 4000);

    const p2 = await client.getChart("tv", "hot", 2);
    assert.equal(p2.list.length, 20);
    // Page 1 = upstream 1 and 2 (8 each) + first 4 of upstream 3.
    assert.equal(p2.list[0].id, "304");
    assert.equal(new Set([...p1.list, ...p2.list].map((i) => i.id)).size, 40);
  });

  test("tv 全部 ends with a short page when trending runs out", async () => {
    const { transport } = fakeTransport((url) => {
      if (url.pathname.endsWith("/images")) return noImages();
      return { total_pages: 1, total_results: 3, results: [
        { id: 1, name: "a", vote_count: 300 }, { id: 2, name: "b", vote_count: 3 }, { id: 3, name: "c", vote_count: 120 }
      ] };
    });
    const data = await new TmdbClient({ transport }).getChart("tv", "hot", 1);
    assert.equal(data.list.length, 2);
    assert.equal(data.total, 2);
  });

  test("poster picks are persisted and reused instead of refetching /images", async () => {
    const route = (url) => url.pathname.endsWith("/images")
      ? { posters: [{ iso_639_1: "en", file_path: "/a.jpg", vote_average: 1 }] }
      : { results: [{ id: 1, title: "t", poster_path: "/raw.jpg", original_language: "en" }] };
    const first = fakeTransport(route);
    await new TmdbClient({ transport: first.transport }).getChart("movie", "top_rated", 1);
    assert.equal(first.calls.filter((p) => p.includes("/images")).length, 1);

    // A fresh client (relaunch) reads the persisted pick.
    const second = fakeTransport(route);
    const data = await new TmdbClient({ transport: second.transport }).getChart("movie", "top_rated", 1);
    assert.equal(second.calls.filter((p) => p.includes("/images")).length, 0);
    assert.equal(data.list[0].poster, "https://image.tmdb.org/t/p/w500/a.jpg");
  });

  test("discover maps labels, region, decade and sort onto TMDB params", async () => {
    const { calls, transport } = fakeTransport((url) =>
      url.pathname.endsWith("/images") ? noImages() : { total_results: 100, results: [] });
    await new TmdbClient({ transport }).getDiscover({
      mediaType: "tv", genre: "喜剧", region: "日本", year: "2010年代", sort: "R"
    });
    const q = new URL(calls[0], "https://api.themoviedb.org").searchParams;
    assert.equal(new URL(calls[0], "https://api.themoviedb.org").pathname, "/3/discover/tv");
    assert.equal(q.get("with_genres"), "35");
    assert.equal(q.get("with_origin_country"), "JP");
    assert.equal(q.get("with_original_language"), "ja");
    assert.equal(q.get("first_air_date.gte"), "2010-01-01");
    assert.equal(q.get("first_air_date.lte"), "2019-12-31");
    assert.equal(q.get("sort_by"), "first_air_date.desc");
    // Date sorts carry no vote floor.
    assert.equal(q.get("vote_count.gte"), null);
  });

  test("rating sort steps the vote floor down until a page fills", async () => {
    const { calls, transport } = fakeTransport((url) => {
      if (url.pathname.endsWith("/images")) return noImages();
      const floor = Number(url.searchParams.get("vote_count.gte"));
      return { total_results: floor <= 80 ? 25 : 3, results: [] };
    });
    await new TmdbClient({ transport }).getDiscover({ mediaType: "movie", sort: "S" });
    const floors = listCalls(calls).map((p) =>
      new URL(p, "https://api.themoviedb.org").searchParams.get("vote_count.gte"));
    assert.deepEqual(floors, ["500", "200", "80"]);
  });

  test("an explicit vote floor disables stepping", async () => {
    const { calls, transport } = fakeTransport((url) =>
      url.pathname.endsWith("/images") ? noImages() : { total_results: 0, results: [] });
    await new TmdbClient({ transport }).getDiscover({ sort: "S", vote_count_gte: 42 });
    assert.equal(listCalls(calls).length, 1);
    assert.match(listCalls(calls)[0], /vote_count\.gte=42/);
  });

  test("sparse zh-CN results are completed from en-US", async () => {
    const { transport } = fakeTransport((url) => {
      if (url.pathname.endsWith("/images")) return noImages();
      return url.searchParams.get("language") === "en-US"
        ? { results: [{ id: 1, title: "English" }] }
        : { results: [{ id: 1, title: "" }] };
    });
    const data = await new TmdbClient({ transport }).getChart("movie", "latest", 1);
    assert.equal(data.list[0].title, "English");
  });

  test("an upstream 5xx retries once in en-US; a 401 propagates", async () => {
    const err = (status) => Object.assign(new Error("x"), { status });
    const retry = fakeTransport((url) => {
      if (url.pathname.endsWith("/images")) return noImages();
      return url.searchParams.get("language") === "en-US"
        ? { results: [{ id: 2, title: "ok" }] }
        : err(502);
    });
    const data = await new TmdbClient({ transport: retry.transport }).getChart("movie", "latest", 1);
    assert.equal(data.list[0].title, "ok");

    const denied = fakeTransport(() => err(401));
    await assert.rejects(
      new TmdbClient({ transport: denied.transport }).getChart("movie", "latest", 1),
      (e) => e.status === 401
    );
  });

  test("without a transport outside webOS, calls fail so the UI falls back", async () => {
    await assert.rejects(new TmdbClient().getChart("movie", "hot", 1), /TMDB_UNAVAILABLE/);
  });

  test("clearLegacyStorage removes the old sidecar address", () => {
    const map = installStorage();
    map.set("decotv.tmdbSidecarUrl", JSON.stringify("http://192.168.0.110:4001"));
    new TmdbClient().clearLegacyStorage();
    assert.equal(map.has("decotv.tmdbSidecarUrl"), false);
  });
});
