// preferEngine.test.js — source filtering and autoplay policy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  filterSearchSources,
  normalizeTitle,
  retryQueries,
  matchesYear,
  inferSearchType,
  runPreferEngine,
  startPreferSession,
  getPreferSession,
  clearPreferSession,
} from "../js/core/network/preferEngine.js";

const source = (name, episodes = ["a"]) => ({
  id: name,
  source: name,
  title: "测试剧集",
  year: "2024",
  episodes,
});

describe("prefer source filtering", () => {
  test("normalizes titles and matches overlapping years", () => {
    assert.equal(normalizeTitle(" 测试 剧集 "), "测试剧集");
    assert.equal(matchesYear("2024-2025", "2024"), true);
    assert.equal(matchesYear("2023", "2024"), false);
  });

  test("infers a tv search and applies the type constraint before fallback", () => {
    assert.equal(inferSearchType(["episode1", "episode2"]), "tv");
    const results = [source("tv", ["a", "b"]), source("movie", ["a"])];
    assert.deepEqual(filterSearchSources(results, "测试剧集", "2024").map((r) => r.id), ["tv"]);
  });

  test("relaxes only the type constraint when every strict match is absent", () => {
    const results = [source("one", ["a"]), { ...source("wrong-year", ["a"]), year: "2023" }];
    assert.deepEqual(filterSearchSources(results, "测试剧集", "2024").map((r) => r.id), ["one"]);
  });
});

// Search-hit shape without episodes: no episode-count type is inferred, so
// these cases exercise the title/year ladder alone (ported from the Android
// TV client's SearchSourceFilterTest, same live-search shapes).
const hit = (title, year, id) => ({ id, source: id, title, year });
const ids = (list) => list.map((r) => r.id);

describe("prefer title/year ladder", () => {
  test("title match ignores punctuation and HTML escapes", () => {
    const results = [
      hit("某系列外传季&amp;怪物季", "2024", "escaped"),
      hit("某系列 外传季 怪物季", "2024", "spaced"),
      hit("某系列：外传季・怪物季", "2024", "fullwidth"),
      hit("某系列第二季", "2013", "other"),
    ];
    assert.deepEqual(ids(filterSearchSources(results, "某系列 外传季&怪物季", "2024")),
      ["escaped", "spaced", "fullwidth"]);
    // Full-width folds to half-width, numeric entities decode, punctuation drops.
    assert.equal(normalizeTitle("Ｆｏｏ&amp;Bar&#x41;：２"), "foobara2");
  });

  test("same title with the wrong year loses to a year-consistent season entry", () => {
    const results = [
      hit("某剧集", "2020", "filmA"),
      hit("某剧集 特别篇", "2020", "filmB"),
      hit("某剧集 第一季", "2008", "s1"),
      hit("某剧集 第一季", "2008", "s2"),
    ];
    assert.deepEqual(ids(filterSearchSources(results, "某剧集", "2008")), ["s1", "s2"]);
  });

  test("blank-year entries join the year-ok bucket", () => {
    const results = [hit("某影片", "", "blank"), hit("某影片", "2011", "real")];
    assert.deepEqual(ids(filterSearchSources(results, "某影片", "2011")), ["blank", "real"]);
  });

  test("a same title from another year is not a match", () => {
    assert.deepEqual(ids(filterSearchSources([hit("某旧片", "2003", "old")], "某旧片", "1999")), []);
  });

  test("title-prefixed entry with the right year when the exact title is absent", () => {
    const results = [hit("某边境剧 第一季", "2019", "season1"), hit("某边境剧 电影之终局", "2021", "film")];
    assert.deepEqual(ids(filterSearchSources(results, "某边境剧", "2019")), ["season1"]);
  });

  test("a title inside an unrelated work's title is not a match", () => {
    // Live search shape (2026-10): a short title only appears inside another work.
    const results = [hit("前缀某名 副题", "2026", "other"), hit("某名后缀", "2026", "prefixed")];
    assert.deepEqual(ids(filterSearchSources(results, "某名", "2026")), ["prefixed"]);
    assert.deepEqual(ids(filterSearchSources([hit("前缀某名 副题", "2026", "other")], "某名", "2026")), []);
  });

  test("seasons from other years are not pulled in", () => {
    const results = [
      hit("某系列 外传季", "2024", "s5"),
      hit("某系列第二季", "2013", "s2"),
      hit("某系列 终季", "2017", "s4"),
    ];
    assert.deepEqual(ids(filterSearchSources(results, "某系列", "2009")), []);
  });

  test("reordered words match when the year agrees", () => {
    const results = [
      hit("某冒险副题", "2026", "joined"),
      hit("某冒险 副题", "2026", "spaced"),
      hit("某冒险 另一部", "2021", "other"),
      hit("某冒险副题", "2012", "wrong-year"),
    ];
    assert.deepEqual(ids(filterSearchSources(results, "副题 某冒险 第二&第三赛段", "2026")), ["joined", "spaced"]);
  });

  test("reordered words need a year and two words", () => {
    const results = [hit("某冒险副题", "2026", "a")];
    assert.deepEqual(ids(filterSearchSources(results, "副题 某冒险", "")), []);
    assert.deepEqual(ids(filterSearchSources(results, "副题 第二季", "2026")), []);
  });

  test("retry queries join, then shorten a spaced title", () => {
    assert.deepEqual(retryQueries("某系列 第二季"), ["某系列第二季", "某系列"]);
    assert.deepEqual(retryQueries("某系列第二季"), []);
    // A one-character head is no query of its own.
    assert.deepEqual(retryQueries("X 某片"), ["X某片"]);
  });

  test("the engine retries joined, then head queries, filtering on the full title", async () => {
    const queries = [];
    const byQuery = {
      "某系列 第二季": [hit("无关", "2020", "noise")],
      "某系列第二季": [],
      "某系列": [hit("某系列第二季", "2015", "s2"), hit("某系列", "2013", "s1")],
    };
    const outcome = await runPreferEngine({
      title: "某系列 第二季",
      year: "2015",
      searchVideos: async (q) => { queries.push(q); return { results: byQuery[q] || [] }; },
      probePlayback: async () => ({ hasError: true }),
    });
    assert.deepEqual(queries, ["某系列 第二季", "某系列第二季", "某系列"]);
    assert.deepEqual(ids(outcome.sources), ["s2"]);
  });

  test("the engine stops at the first query that matches", async () => {
    const queries = [];
    await runPreferEngine({
      title: "某系列 第二季",
      year: "",
      searchVideos: async (q) => { queries.push(q); return { results: [hit("某系列 第二季", "", "x")] }; },
      probePlayback: async () => ({ hasError: true }),
    });
    assert.deepEqual(queries, ["某系列 第二季"]);
  });
});

describe("prefer session", () => {
  test("one live session per work, found again by title and year once it has sources", () => {
    clearPreferSession();
    const session = startPreferSession("测试剧集", "2024");
    // No sources yet: nothing to restore.
    assert.equal(getPreferSession("测试剧集", "2024"), null);
    session.sources = [source("s1", ["a", "b"])];
    session.probeResults.set("s1-s1", { status: "ok" });
    session.currentSourceKey = "s1-s1";
    session.failedSourceKeys.add("s1-s1");
    // The same objects come back — no copies.
    assert.equal(getPreferSession("测试剧集", "2024"), session);
    assert.equal(getPreferSession("其他", "2024"), null);
    // A fresh visit replaces it.
    const next = startPreferSession("测试剧集", "2024");
    assert.notEqual(next, session);
    assert.equal(next.probeResults.size, 0);
    assert.equal(next.failedSourceKeys.size, 0);
  });

  test("the engine writes probe results into the caller's Map in place", async () => {
    const shared = new Map();
    const seenMidRun = [];
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      existingProbeResults: shared,
      concurrency: 1,
      searchVideos: async () => ({ results: [source("s1"), source("s2")] }),
      probePlayback: async () => ({ status: "ok", playable: true, startupTimeMs: 100 }),
      // A reader holding the Map (the player) sees each result as it lands.
      onProgress: () => seenMidRun.push(shared.size),
    });
    assert.equal(result.probeResults, shared);
    assert.equal(shared.size, 2);
    assert.deepEqual(seenMidRun, [1, 2]);
  });
});

describe("prefer probing", () => {
  test("quality shortcut picks the best completed result without waiting for all probes", async () => {
    const sources = [source("s1", ["one", "two"]), source("s2", ["three", "four"]), source("s3", ["five", "six"])]
      .map((item, i) => ({ ...item, id: String(i + 1) }));
    const picks = [];
    const progress = [];
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      autoPlay: true,
      searchVideos: async () => ({ results: sources }),
      probePlayback: async (_url, sourceName) => ({
        status: "ok",
        playable: true,
        quality: sourceName === "s1" ? "1080p" : "720p",
        speedKBps: sourceName === "s1" ? 5000 : 1000,
        startupTimeMs: 100,
      }),
      onPick: ({ source }) => picks.push(source.source),
      onProgress: ({ done, total }) => progress.push([done, total]),
    });
    assert.equal(result.best.source, "s1");
    assert.deepEqual(picks, ["s1"]);
    assert.equal(progress.length, 3);
  });

  test("records failed probes and falls back to the first source", async () => {
    const sources = [source("s1"), source("s2")];
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      searchVideos: async () => ({ results: sources }),
      probePlayback: async () => ({ status: "failed", hasError: true, message: "down" }),
    });
    assert.equal(result.best.source, "s1");
    assert.equal(result.probeResults.get("s1-s1").status, "failed");
  });
});

describe("prefer round width and deadlines", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  test("a narrowed round keeps going on fewer workers until every source is probed", async () => {
    const sources = Array.from({ length: 12 }, (_, i) => source(`s${i}`));
    let width = 8;
    let started = 0;
    let lateInFlight = 0; // probes started after the round narrowed
    let latePeak = 0;
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      searchVideos: async () => ({ results: sources }),
      concurrency: () => width,
      probePlayback: async () => {
        started += 1;
        const late = width === 2;
        if (late) latePeak = Math.max(latePeak, ++lateInFlight);
        await new Promise((r) => setTimeout(r, 5));
        if (late) lateInFlight -= 1;
        return { status: "ok", playable: true, startupTimeMs: 100 };
      },
      // Playback starts after the first result: the round narrows to 2.
      // Probes already in flight finish; only 2 workers take new sources.
      onProgress: () => { width = 2; },
    });
    assert.equal(started, 12);
    assert.equal(result.probeResults.size, 12);
    assert.equal(latePeak, 2);
  });

  test("a slow round that keeps progressing is not cut by the idle abort", async () => {
    const sources = Array.from({ length: 6 }, (_, i) => source(`s${i}`));
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      searchVideos: async () => ({ results: sources }),
      concurrency: 1,
      idleAbortMs: 40,
      // 6 x 20 ms = 120 ms total, three times the idle window, but a
      // result lands every 20 ms.
      probePlayback: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "ok", playable: true, startupTimeMs: 100 };
      },
    });
    const results = [...result.probeResults.values()];
    assert.equal(results.length, 6);
    assert.ok(results.every((r) => r.status === "ok"));
  });

  test("a round with no progress for the idle window is aborted", async () => {
    const hang = deferred();
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      searchVideos: async () => ({ results: [source("s1")] }),
      idleAbortMs: 30,
      probePlayback: (_url, _name, _timeout, signal) => {
        signal.addEventListener("abort", () => hang.resolve());
        return hang.promise.then(() => { throw new Error("aborted"); });
      },
    });
    assert.equal(result.probeResults.get("s1-s1").failureKind, "timeout");
  });
});
