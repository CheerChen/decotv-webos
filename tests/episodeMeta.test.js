import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  chineseNumeral,
  seasonSearchTitles,
  anchorSeason,
  genericEpisodeName,
  tmdbEpisodeMeta,
  bangumiEpisodeMeta,
  loadEpisodeMeta,
  _resetEpisodeMetaMemo,
} from "../js/core/catalog/episodeMeta.js";

const season = (n, name, air, count = 10) => ({ season_number: n, name, air_date: air, episode_count: count });

describe("season titles and anchoring", () => {
  test("chinese numerals 1-99", () => {
    assert.equal(chineseNumeral(1), "一");
    assert.equal(chineseNumeral(10), "十");
    assert.equal(chineseNumeral(12), "十二");
    assert.equal(chineseNumeral(20), "二十");
    assert.equal(chineseNumeral(99), "九十九");
  });

  test("a named season is listed by its name, a generic one as <show> 第N季", () => {
    assert.deepEqual(seasonSearchTitles("某剧", 2, "某剧之归来"), ["某剧之归来"]);
    assert.deepEqual(seasonSearchTitles("某剧", 1, "第 1 季"), ["某剧"]);
    assert.deepEqual(seasonSearchTitles("某剧", 3, "Season 3"), ["某剧 第三季", "某剧 第3季"]);
  });

  test("anchors on the season the source title names, else the show, else the air year", () => {
    const seasons = [season(1, "第 1 季", "2019-01-01"), season(2, "第 2 季", "2021-03-01"), season(3, "某剧之终章", "2023-05-01")];
    assert.equal(anchorSeason("某剧", "某剧 第二季", "", seasons), 1);
    // Sites spell the season with a digit too, with or without the space.
    assert.equal(anchorSeason("某剧", "某剧第2季", "", seasons), 1);
    assert.equal(anchorSeason("某剧", "某剧之终章", "", seasons), 2);
    assert.equal(anchorSeason("某剧", "某剧", "2023", seasons), 0);
    // Unnamed in the listing: the air year decides.
    assert.equal(anchorSeason("某剧", "某剧 特别版", "2021", seasons), 1);
    assert.equal(anchorSeason("某剧", "某剧 特别版", "2030", seasons), 0);
    assert.equal(anchorSeason("某剧", "", "2021", seasons), 0);
  });

  test("placeholder episode names are no titles", () => {
    assert.equal(genericEpisodeName("第 3 集"), true);
    assert.equal(genericEpisodeName("第十二集"), true);
    assert.equal(genericEpisodeName("Episode 7"), true);
    assert.equal(genericEpisodeName(""), true);
    assert.equal(genericEpisodeName("某个夜晚"), false);
  });
});

describe("tmdb episode meta", () => {
  const eps = (n, stillEvery = 1) => ({
    episodes: Array.from({ length: n }, (_, i) => ({
      episode_number: i + 1,
      name: i === 1 ? `第 ${i + 1} 集` : `某集${i + 1}`,
      still_path: i % stillEvery === 0 ? `/s${i + 1}.jpg` : null,
    })),
  });

  test("maps the anchor season, then continues into the next one", async () => {
    const calls = [];
    const meta = await tmdbEpisodeMeta({
      showId: "9", showName: "某剧",
      seasons: [season(0, "特别篇", "2018-01-01", 2), season(1, "第 1 季", "2019-01-01", 3), season(2, "第 2 季", "2020-01-01", 3)],
      sourceTitle: "某剧", sourceYear: "", episodeCount: 5,
      getSeason: async (id, n) => { calls.push(n); return eps(3, 2); },
    });
    // Specials (season 0) never count; 3 from season 1 + 2 from season 2.
    assert.deepEqual(calls, [1, 2]);
    assert.equal(meta.size, 5);
    assert.deepEqual(meta.get(0), { still: "https://image.tmdb.org/t/p/w300/s1.jpg", title: "某集1" });
    // Placeholder name dropped; missing still is an empty string.
    assert.deepEqual(meta.get(1), { still: "", title: "" });
    assert.equal(meta.get(3).title, "某集1");
  });

  test("a source of a later season starts at that season", async () => {
    const calls = [];
    await tmdbEpisodeMeta({
      showId: "9", showName: "某剧",
      seasons: [season(1, "", "2019-01-01", 3), season(2, "", "2020-01-01", 3)],
      sourceTitle: "某剧 第二季", sourceYear: "", episodeCount: 3,
      getSeason: async (id, n) => { calls.push(n); return eps(3); },
    });
    assert.deepEqual(calls, [2]);
  });
});

describe("bangumi episode meta", () => {
  test("chinese title, then original, placeholders skipped, capped at the source count", () => {
    const meta = bangumiEpisodeMeta([
      { name_cn: "中文一", name: "原一" }, { name_cn: "", name: "原二" }, { name_cn: "第3集", name: "" }, { name_cn: "中文四" },
    ], 3);
    assert.deepEqual([...meta.entries()], [[0, { still: "", title: "中文一" }], [1, { still: "", title: "原二" }]]);
  });
});

describe("loadEpisodeMeta gating", () => {
  beforeEach(() => _resetEpisodeMetaMemo());
  const source = { title: "某剧", year: "2019", episodes: ["a", "b", "c"] };

  test("douban works, TMDB movies and single-episode sources get nothing", async () => {
    let asked = 0;
    const deps = { getSeason: async () => { asked++; return { episodes: [] }; }, getEpisodes: async () => { asked++; return []; } };
    assert.equal((await loadEpisodeMeta({ provider: "douban", kind: "tv", id: "1" }, {}, source, deps)).size, 0);
    assert.equal((await loadEpisodeMeta({ provider: "tmdb", kind: "movie", id: "1" }, { seasons: [season(1, "", "", 3)] }, source, deps)).size, 0);
    assert.equal((await loadEpisodeMeta({ provider: "tmdb", kind: "tv", id: "1" }, { seasons: [season(1, "", "", 3)] }, { ...source, episodes: ["a"] }, deps)).size, 0);
    // Long-running series keep the text buttons.
    const long = { ...source, episodes: Array.from({ length: 121 }, () => "x") };
    assert.equal((await loadEpisodeMeta({ provider: "bangumi", kind: "", id: "1" }, {}, long, deps)).size, 0);
    assert.equal(asked, 0);
  });

  test("a failing provider degrades to nothing; results are memoised per source", async () => {
    const failing = { getSeason: async () => { throw new Error("boom"); } };
    const details = { title: "某剧", seasons: [season(1, "", "2019-01-01", 3)] };
    assert.equal((await loadEpisodeMeta({ provider: "tmdb", kind: "tv", id: "2" }, details, source, failing)).size, 0);
    let calls = 0;
    const ok = { getSeason: async () => { calls++; return { episodes: [{ episode_number: 1, name: "某集", still_path: "/a.jpg" }] }; } };
    await loadEpisodeMeta({ provider: "tmdb", kind: "tv", id: "2" }, details, source, ok);
    await loadEpisodeMeta({ provider: "tmdb", kind: "tv", id: "2" }, details, source, ok);
    assert.equal(calls, 1);
  });
});
