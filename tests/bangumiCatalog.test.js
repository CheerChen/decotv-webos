import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  regionTag,
  airDateRange,
  subjectToCard,
  getHotAnimePage,
  getAnimeBrowsePage,
  _resetBangumiCatalog,
} from "../js/core/catalog/bangumiCatalog.js";
import { dateFromInfo } from "../js/core/network/bangumiClient.js";

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

let calls;
let previousFetch;
function stubFetch(route) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return route(call);
  };
}

const trendingSubject = (id, tags, extra = {}) => ({
  subject: { id, type: 2, nsfw: false, name: `原${id}`, nameCN: `中${id}`, images: { common: `https://img.example/${id}.jpg` },
    rating: { score: 7.04, total: 300 }, metaTags: tags, info: "12话 / 2026年4月5日 / 某人", ...extra },
});

describe("bangumi catalog helpers", () => {
  test("region chips map to Bangumi region tags", () => {
    assert.deepEqual(regionTag("华语"), ["中国"]);
    assert.deepEqual(regionTag("国产"), ["中国"]);
    assert.deepEqual(regionTag("日本"), ["日本"]);
    assert.deepEqual(regionTag("欧美"), ["欧美"]);
    assert.deepEqual(regionTag(""), []);
  });

  test("year chips map to air-date predicates", () => {
    assert.deepEqual(airDateRange("2025"), [">=2025-01-01", "<=2025-12-31"]);
    assert.deepEqual(airDateRange("2010年代"), [">=2010-01-01", "<=2019-12-31"]);
    assert.deepEqual(airDateRange("90年代"), [">=1990-01-01", "<=1999-12-31"]);
    assert.deepEqual(airDateRange("更早"), ["<=1979-12-31"]);
    assert.deepEqual(airDateRange("all"), []);
  });

  test("the trending list's date comes out of its info line", () => {
    assert.equal(dateFromInfo("12话 / 2026年10月1日 / 某人"), "2026-10-01");
    assert.equal(dateFromInfo("2025年 / 某人"), "2025");
    assert.equal(dateFromInfo(""), "");
  });

  test("cards carry a bangumi work, the Chinese name and the air year", () => {
    const c = subjectToCard({ id: 9, name: "原名", name_cn: "中文名", date: "2026-04-05", rating: { score: 7.04, total: 300 }, images: { common: "c" } });
    assert.deepEqual(c, { id: "9", title: "中文名", poster: "c", rate: "7.0", votes: 300, year: "2026", work: { provider: "bangumi", kind: "", id: "9" } });
  });
});

describe("bangumi catalog requests", () => {
  beforeEach(() => { previousFetch = globalThis.fetch; _resetBangumiCatalog(); });
  afterEach(() => { globalThis.fetch = previousFetch; });

  test("热门 slices the trending pool; a region trending leaves short falls back to recent heat", async () => {
    stubFetch((call) => {
      if (call.url.includes("next.bgm.tv/p1/trending")) {
        return json({ data: [
          ...Array.from({ length: 30 }, (_, i) => trendingSubject(100 + i, ["日本", "TV"])),
          trendingSubject(999, ["中国"]),
          trendingSubject(998, ["日本"], { nsfw: true }),
          // Below the 100-vote floor: never in the pool.
          trendingSubject(997, ["日本"], { rating: { score: 8, total: 99 } }),
        ] });
      }
      if (call.url.includes("/v0/search/subjects")) {
        const offset = Number(new URL(call.url).searchParams.get("offset"));
        return json({ total: 100, data: Array.from({ length: 20 }, (_, i) => ({ id: 5000 + offset + i, name_cn: `搜${offset + i}`, date: "2026-03-01", rating: { score: 6, total: 10 }, images: {} })) });
      }
      return json({}, 404);
    });

    const all = await getHotAnimePage("", 0, 20);
    assert.equal(all.length, 20);
    assert.equal(all[0].title, "中100");
    assert.equal(all[0].year, "2026");
    const page2 = await getHotAnimePage("", 20, 20);
    // 31 safe trending entries (the NSFW one dropped) → 11 on page 2.
    assert.equal(page2.length, 11);
    assert.equal(calls.filter((c) => c.url.includes("trending")).length, 1, "pool is cached");

    const cn = await getHotAnimePage("华语", 0, 20);
    const searches = calls.filter((c) => c.url.includes("/v0/search/subjects"));
    assert.equal(searches.length, 5, "5 pages of 20 for the recent-heat pool");
    assert.deepEqual(searches[0].body.filter.tag, ["中国"]);
    assert.equal(searches[0].body.sort, "heat");
    assert.equal(searches[0].body.filter.air_date.length, 2);
    const [from, to] = searches[0].body.filter.air_date.map((d) => Date.parse(d.slice(2)));
    assert.equal(Math.round((to - from) / 86400000), 730, "two-year fallback window");
    assert.deepEqual(searches[0].body.filter.rating_count, [">=100"]);
    assert.equal(cn.length, 20);
  });

  test("trending failing entirely also falls back to recent heat", async () => {
    stubFetch((call) => call.url.includes("trending")
      ? json({}, 500)
      : json({ total: 1, data: [{ id: 1, name_cn: "某番", date: "2026-01-01", images: {} }] }));
    const list = await getHotAnimePage("", 0, 20);
    assert.equal(list[0].title, "某番");
  });

  test("动漫 chips map onto the search: score sort gets a vote floor, heat gets a recent window", async () => {
    stubFetch(() => json({ total: 0, data: [] }));
    await getAnimeBrowsePage({ region: "日本", year: "all", sort: "S" }, 40);
    let call = calls.at(-1);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).searchParams.get("offset"), "40");
    assert.equal(call.body.sort, "score");
    assert.deepEqual(call.body.filter.rating_count, [">=100"]);
    assert.deepEqual(call.body.filter.tag, ["日本"]);
    assert.deepEqual(call.body.filter.type, [2]);
    assert.equal(call.body.filter.nsfw, false);

    await getAnimeBrowsePage({ region: "", year: "all", sort: "U" }, 0);
    call = calls.at(-1);
    assert.equal(call.body.sort, "heat");
    assert.equal(call.body.filter.air_date.length, 2, "<=today and >=180 days ago");
    assert.equal(call.body.filter.tag, undefined);

    await getAnimeBrowsePage({ region: "", year: "2024", sort: "U" }, 0);
    call = calls.at(-1);
    assert.deepEqual(call.body.filter.air_date.slice(0, 2), [">=2024-01-01", "<=2024-12-31"]);
    assert.equal(call.body.filter.air_date.length, 3, "a chosen year is its own window");

    await getAnimeBrowsePage({ sort: "T" }, 0);
    call = calls.at(-1);
    assert.equal(call.body.sort, "heat");
    assert.equal(call.body.filter.air_date.length, 1, "all-time: only <=today");
  });
});
