import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeWork, normalizeWork, workKey, rememberWork, lookupWork } from "../js/core/catalog/work.js";
import {
  normalizeDoubanSubject,
  normalizeTmdbDetails,
  normalizeBangumiSubject,
  chineseSummary,
  getWorkDetails,
  getWorkBackdrop,
  pickHeroStill,
  _resetWorkDetailsCache,
} from "../js/core/catalog/workDetails.js";
import { getHeroStyle, setHeroStyle } from "../js/core/storage/heroStyle.js";
import { getSubject, _resetForTest as resetDouban } from "../js/core/network/doubanDirect.js";

function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

describe("work identity", () => {
  test("valid works per provider; kind required where the id space is typed", () => {
    assert.deepEqual(makeWork("douban", "tv", 123), { provider: "douban", kind: "tv", id: "123" });
    assert.deepEqual(makeWork("tmdb", "movie", "7"), { provider: "tmdb", kind: "movie", id: "7" });
    assert.deepEqual(makeWork("bangumi", "", 42), { provider: "bangumi", kind: "", id: "42" });
    assert.equal(makeWork("tmdb", "", 7), null);
    assert.equal(makeWork("douban", "book", 1), null);
    assert.equal(makeWork("douban", "movie", "d1"), null);
    assert.equal(makeWork("douban", "movie", 0), null);
    assert.equal(makeWork("server", "movie", 1), null);
    assert.equal(normalizeWork({ provider: "tmdb", kind: "tv", id: 5, extra: 1 }).id, "5");
    assert.equal(normalizeWork("tmdb:tv:5"), null);
  });

  test("keys keep the kind so TMDB movie and tv ids never collide", () => {
    assert.equal(workKey(makeWork("tmdb", "movie", 5)), "tmdb:movie:5");
    assert.equal(workKey(makeWork("tmdb", "tv", 5)), "tmdb:tv:5");
    assert.equal(workKey(makeWork("bangumi", "", 5)), "bangumi:5");
  });

  test("the local map finds a work by title and year, newest wins", () => {
    installStorage();
    rememberWork("某剧集", "2024", makeWork("douban", "tv", 1));
    rememberWork("某剧集", "2024", makeWork("tmdb", "tv", 2));
    assert.deepEqual(lookupWork("某剧集", "2024"), { provider: "tmdb", kind: "tv", id: "2" });
    assert.equal(lookupWork("某剧集", "2023"), null);
    rememberWork("", "", makeWork("douban", "tv", 1));
    assert.equal(lookupWork("", ""), null);
  });
});

describe("provider detail normalization", () => {
  test("douban subject", () => {
    const d = normalizeDoubanSubject({
      id: "1", title: "某片", year: "2026", intro: " 简介 ",
      rating: { value: 7.25, count: 26124 }, genres: ["犯罪", "剧情", "悬疑", "动作"],
      durations: ["140 分钟"], episodes_count: 0,
      directors: [{ name: "导演甲" }], actors: Array.from({ length: 20 }, (_, i) => ({ name: `演员${i}` })),
      pic: { large: "https://img.example/l.jpg" },
    });
    assert.equal(d.summary, "简介");
    assert.deepEqual(d.rating, { source: "豆瓣", value: "7.3", votes: 26124 });
    assert.deepEqual(d.genres, ["犯罪", "剧情", "悬疑"]);
    assert.equal(d.duration, "140分钟");
    assert.deepEqual(d.directors, ["导演甲"]);
    assert.equal(d.cast.length, 12);
    assert.equal(normalizeDoubanSubject({ msg: "x" }), null);
  });

  test("tmdb tv: creators when no director, runtime, seasons kept", () => {
    const d = normalizeTmdbDetails({
      id: 9, name: "某剧", first_air_date: "2025-03-01", overview: "概要", vote_average: 8.12, vote_count: 900,
      genres: [{ name: "剧情" }, { name: "Sci-Fi & Fantasy" }], episode_run_time: [45], number_of_episodes: 16,
      created_by: [{ name: "主创甲" }], credits: { crew: [{ job: "Writer", name: "x" }], cast: [{ name: "演员甲" }] },
      poster_path: "/p.jpg", backdrop_path: "/b.jpg", seasons: [{ season_number: 1 }],
    }, "tv");
    assert.equal(d.year, "2025");
    assert.deepEqual(d.rating, { source: "TMDB", value: "8.1", votes: 900 });
    assert.equal(d.duration, "45分钟");
    assert.deepEqual(d.genres, ["剧情", "科幻奇幻"]);
    assert.equal(d.episodes, 16);
    assert.deepEqual(d.directors, ["主创甲"]);
    assert.equal(d.backdrop, "https://image.tmdb.org/t/p/w1280/b.jpg");
    assert.equal(d.seasons.length, 1);
    // No rating without votes.
    assert.equal(normalizeTmdbDetails({ id: 1, title: "t", vote_average: 0 }, "movie").rating, null);
  });

  test("bangumi subject: meta tags minus medium/region, director from infobox", () => {
    const d = normalizeBangumiSubject({
      id: 3, name: "原名", name_cn: "中文名", date: "2026-10-01", summary: "s",
      rating: { score: 7.1, total: 649 }, meta_tags: ["日本", "TV", "漫画改", "漫画改", "奇幻", "战斗", "恋爱"],
      total_episodes: 12, infobox: [{ key: "导演", value: "导演甲" }], images: { large: "https://img.example/l.jpg" },
    });
    assert.equal(d.title, "中文名");
    assert.deepEqual(d.genres, ["漫画改", "奇幻", "战斗"]);
    assert.deepEqual(d.directors, ["导演甲"]);
    assert.equal(d.episodes, 12);
    assert.deepEqual(normalizeBangumiSubject({ id: 1, infobox: [{ key: "导演", value: [{ v: "甲" }, { v: "乙" }] }] }).directors, ["甲", "乙"]);
  });
});

describe("bangumi summary", () => {
  test("keeps the Chinese part before the [简介原文] marker", () => {
    const text = "中文第一段，讲述某个故事的开端。\r\n中文第二段，继续讲述。\r\n\r\n[简介原文]\r\nある物語の始まりを描く。\r\n続きの物語です。";
    assert.equal(chineseSummary(text), "中文第一段，讲述某个故事的开端。\n中文第二段，继续讲述。");
  });

  test("without a marker, Japanese paragraphs go when Chinese ones exist; katakana names stay Chinese", () => {
    const text = "这是一个关于少年冒险成长的中文简介段落。\nこれは少年の冒険と成長の物語である。\n第二段中文，人物名ナナシ出现也算中文。";
    assert.equal(chineseSummary(text), "这是一个关于少年冒险成长的中文简介段落。\n第二段中文，人物名ナナシ出现也算中文。");
  });

  test("a Japanese-only summary is kept; empty stays empty", () => {
    assert.equal(chineseSummary("これは物語です。\n続きです。"), "これは物語です。\n続きです。");
    assert.equal(chineseSummary("[简介原文]\nこれは物語です。"), "これは物語です。");
    assert.equal(chineseSummary(""), "");
  });
});

describe("getWorkDetails", () => {
  beforeEach(() => _resetWorkDetailsCache());

  test("memoises per work and never throws", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return { provider: "douban", title: "t" }; };
    const w = makeWork("douban", "movie", 1);
    await getWorkDetails(w, { fetcher });
    await getWorkDetails({ ...w }, { fetcher });
    assert.equal(calls, 1);
    const failing = async () => { throw new Error("boom"); };
    assert.equal(await getWorkDetails(makeWork("tmdb", "tv", 2), { fetcher: failing }), null);
    assert.equal(await getWorkDetails(null, { fetcher }), null);
  });

  test("expires after the TTL", async () => {
    let calls = 0;
    let t = 0;
    const fetcher = async () => { calls++; return { provider: "tmdb" }; };
    const w = makeWork("tmdb", "movie", 3);
    await getWorkDetails(w, { fetcher, now: () => t });
    t += 7 * 60 * 60 * 1000;
    await getWorkDetails(w, { fetcher, now: () => t });
    assert.equal(calls, 2);
  });
});

describe("douban getSubject", () => {
  function stubLuna(responder) {
    globalThis.window = {
      webOS: {
        service: {
          request(_uri, options) {
            options.onSuccess({ returnValue: true, contentType: "application/json", ...responder(options.parameters.path) });
            return { cancel() {} };
          },
        },
      },
    };
  }

  test("404 and need_permission are answers, not outages; other errors count toward the breaker", async () => {
    const previous = globalThis.window;
    resetDouban();
    try {
      stubLuna(() => ({ status: 404, body: "{}" }));
      assert.equal(await getSubject("movie", 1), null);
      stubLuna(() => ({ status: 403, body: '{"msg":"need_permission"}' }));
      assert.equal(await getSubject("tv", 2), null);
      stubLuna((path) => ({ status: 200, body: JSON.stringify({ id: "3", path }) }));
      assert.equal((await getSubject("tv", 3)).path, "/rexxar/api/v2/tv/3");
      stubLuna(() => ({ status: 500, body: "" }));
      for (let i = 0; i < 3; i++) await assert.rejects(getSubject("movie", 4), /DOUBAN_HTTP_500/);
      // Breaker open after three failures: fail fast without a request.
      await assert.rejects(getSubject("movie", 5), /DOUBAN_UNAVAILABLE/);
      await assert.rejects(getSubject("book", 5), /DOUBAN_BAD_KIND/);
    } finally {
      globalThis.window = previous;
      resetDouban();
    }
  });
});

describe("landscape hero", () => {
  const photo = (url, w, h) => ({ image: { large: { url, width: w, height: h } } });

  test("the frame closest to 16:9 wins among wide-enough landscape photos", () => {
    assert.equal(pickHeroStill([photo("promo-3x2", 1500, 1000), photo("still-16x9", 1920, 1080)]), "still-16x9");
    assert.equal(pickHeroStill([photo("cover", 1066, 1600), photo("promo-3x2", 1500, 1000)]), "promo-3x2");
    assert.equal(pickHeroStill([
      photo("portrait", 1066, 1600), photo("square", 1400, 1400), photo("narrow", 1000, 562), photo("banner", 3000, 1000),
    ]), "");
    assert.equal(pickHeroStill(null), "");
  });

  test("backdrop per provider; douban photo walls are fetched once", async () => {
    _resetWorkDetailsCache();
    let calls = 0;
    const photos = async () => { calls++; return [photo("still", 1920, 1080)]; };
    assert.equal(await getWorkBackdrop(makeWork("tmdb", "tv", 1), { backdrop: "tmdb-bd" }, { photos }), "tmdb-bd");
    assert.equal(await getWorkBackdrop(makeWork("bangumi", "", 1), {}, { photos }), "");
    assert.equal(await getWorkBackdrop(makeWork("douban", "tv", 2), {}, { photos }), "still");
    assert.equal(await getWorkBackdrop(makeWork("douban", "tv", 2), {}, { photos }), "still");
    assert.equal(calls, 1);
    assert.equal(await getWorkBackdrop(makeWork("douban", "tv", 3), {}, { photos: async () => { throw new Error("x"); } }), "");
  });

  test("hero style defaults to the portrait poster", () => {
    installStorage();
    assert.equal(getHeroStyle(), "poster");
    setHeroStyle("backdrop");
    assert.equal(getHeroStyle(), "backdrop");
    setHeroStyle("anything");
    assert.equal(getHeroStyle(), "poster");
  });
});
