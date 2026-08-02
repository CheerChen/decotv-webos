// preferEngine.test.js — source filtering and autoplay policy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  filterSearchSources,
  normalizeTitle,
  matchesYear,
  inferSearchType,
  runPreferEngine,
  savePreferCache,
  getPreferCache,
  clearPreferCache,
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

describe("prefer cache", () => {
  test("stores and restores probe entries by title and year", () => {
    clearPreferCache();
    const sources = [source("s1", ["a", "b"] )];
    const probeResults = new Map([["s1-s1", { status: "ok" }]]);
    savePreferCache({ title: "测试剧集", year: "2024", sources, probeResults, currentSourceKey: "s1-s1" });
    const cached = getPreferCache("测试剧集", "2024");
    assert.equal(cached.currentSourceKey, "s1-s1");
    assert.deepEqual(cached.probeResults, [["s1-s1", { status: "ok" }]]);
    assert.equal(getPreferCache("其他", "2024"), null);
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
