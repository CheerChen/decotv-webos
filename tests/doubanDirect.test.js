import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildRecommendPath,
  mapRexxarItem,
  getRecommendPage,
  getRecentHotPage,
  getChartPage,
  _resetForTest
} from "../js/core/network/doubanDirect.js";

// ── harness: fake the webOS Luna bus ──────────────────────────────────────

let serviceCalls = [];
let responseQueue = [];

function installLuna() {
  serviceCalls = [];
  responseQueue = [];
  globalThis.window = {
    webOS: {
      service: {
        request(uri, options) {
          serviceCalls.push({ uri, method: options.method, parameters: options.parameters });
          const next = responseQueue.shift();
          if (!next) {
            options.onFailure({ errorText: "NO_MOCK_RESPONSE" });
            return;
          }
          if (next instanceof Error) {
            options.onFailure({ errorText: next.message });
          } else {
            options.onSuccess(next);
          }
        }
      }
    }
  };
}

function removeLuna() {
  delete globalThis.window;
}

function rexxarResponse(items) {
  return {
    returnValue: true,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ total: 500, items })
  };
}

function rawItem(id, votes, title = `item-${id}`, type = "movie") {
  return {
    id: String(id),
    title,
    type,
    year: "2020",
    pic: { normal: `https://img.doubanio.com/p${id}.jpg` },
    rating: { value: 9.5, count: votes },
    card_subtitle: `2020 / 美国 / 剧情 / dir / cast`
  };
}

beforeEach(() => {
  _resetForTest();
});

// ── URL building ──────────────────────────────────────────────────────────

describe("buildRecommendPath", () => {
  test("mirrors the server route's param assembly", () => {
    const path = buildRecommendPath("movie",
      { category: "", format: "", region: "华语", year: "", platform: "", label: "", sort: "S" },
      0, 20);
    assert.ok(path.startsWith("/rexxar/api/v2/movie/recommend?"));
    assert.ok(path.includes("refresh=0"));
    assert.ok(path.includes("start=0"));
    assert.ok(path.includes("count=20"));
    assert.ok(path.includes(encodeURIComponent(JSON.stringify({ "类型": "", "地区": "华语" }))));
    assert.ok(path.includes(encodeURIComponent("华语")));
    assert.ok(path.includes("sort=S"));
    assert.ok(path.includes("score_range=0%2C10"));
  });

  test("normalizes all/T to empty and drops empty sort", () => {
    const path = buildRecommendPath("tv",
      { category: "all", format: "all", region: "all", sort: "T" }, 40, 60);
    assert.ok(!path.includes("sort="));
    assert.ok(path.includes("start=40"));
    assert.ok(path.includes("count=60"));
    // only the fixed 类型 key remains, empty
    assert.ok(path.includes(encodeURIComponent(JSON.stringify({ "类型": "" }))));
  });
});

// ── item mapping ──────────────────────────────────────────────────────────

describe("mapRexxarItem", () => {
  test("keeps the DoubanItem shape and adds votes/subtitle", () => {
    const mapped = mapRexxarItem(rawItem(1, 3216, "演唱会"));
    assert.equal(mapped.id, "1");
    assert.equal(mapped.title, "演唱会");
    assert.equal(mapped.rate, "9.5");
    assert.equal(mapped.votes, 3216);
    assert.equal(mapped.year, "2020");
    assert.ok(mapped.poster.includes("doubanio"));
    assert.ok(mapped.subtitle.includes("剧情"));
  });

  test("survives missing rating", () => {
    const mapped = mapRexxarItem({ id: 2, title: "x", type: "movie" });
    assert.equal(mapped.rate, "");
    assert.equal(mapped.votes, 0);
  });

  test("subject_collection variant: cover.url poster, year from card_subtitle", () => {
    const mapped = mapRexxarItem({
      id: "9", title: "y", type: "movie",
      cover: { url: "https://img.doubanio.com/c9.jpg" },
      rating: { value: 7.25, count: 50021 },
      card_subtitle: "2026 / 中国大陆 / 犯罪 / dir / cast",
    });
    assert.equal(mapped.poster, "https://img.doubanio.com/c9.jpg");
    assert.equal(mapped.rate, "7.3"); // toFixed(1) rounds
    assert.equal(mapped.year, "2026");
    assert.equal(mapped.votes, 50021);
  });
});

// ── direct page serving ───────────────────────────────────────────────────

describe("getRecommendPage", () => {
  test("returns null without Luna transport (browser dev falls back)", async () => {
    removeLuna();
    assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
  });

  test("vote floor filters low-vote items out of sort=S pages", async () => {
    installLuna();
    // 60 raw items: alternating high/low votes. A strict 10k floor keeps 30.
    const batch = [];
    for (let i = 0; i < 60; i++) {
      batch.push(rawItem(i, i % 2 === 0 ? 500000 : 3000));
    }
    responseQueue.push(rexxarResponse(batch));

    const page = await getRecommendPage("movie", { region: "华语", sort: "S", start: 0 }, 20);
    assert.equal(page.length, 20);
    for (const item of page) {
      assert.ok(item.votes >= 10000, `votes ${item.votes} passed the floor`);
    }
    // exactly one upstream request served the whole page (batch 60 → 30 kept)
    assert.equal(serviceCalls.length, 1);
    removeLuna();
  });

  test("non-S sorts pass through without vote filtering", async () => {
    installLuna();
    const batch = [];
    for (let i = 0; i < 25; i++) batch.push(rawItem(i, 12));
    responseQueue.push(rexxarResponse(batch));

    const page = await getRecommendPage("movie", { sort: "U", start: 0 }, 20);
    assert.equal(page.length, 20);
    assert.equal(page[0].votes, 12);
    removeLuna();
  });

  test("floor steps down for starving queries but never below the last step", async () => {
    installLuna();
    // Five distinct low-vote batches: two starve at 10k (→ step to 3k),
    // two starve at 3k (→ step to 1k), the fifth finally survives.
    const batchOf = (base) => {
      const items = [];
      for (let i = 0; i < 60; i++) items.push(rawItem(base + i, 1200));
      return rexxarResponse(items);
    };
    responseQueue.push(batchOf(0), batchOf(100), batchOf(200), batchOf(300), batchOf(400));

    const page = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.equal(page.length, 20);
    // 1200 votes only survive at the 1000 floor
    assert.ok(page.every((item) => item.votes >= 1000));
    assert.equal(serviceCalls.length, 5);
    removeLuna();
  });

  test("sub-floor items never return even after the floor loosens", async () => {
    installLuna();
    const batch1 = [];
    for (let i = 0; i < 60; i++) batch1.push(rawItem(i, 500)); // all below 1000
    const batch2 = [];
    for (let i = 100; i < 160; i++) batch2.push(rawItem(i, 400000));
    responseQueue.push(rexxarResponse(batch1), rexxarResponse(batch1),
      rexxarResponse(batch1), rexxarResponse(batch1),
      rexxarResponse(batch2)); // finally a high-vote batch ends the page

    const page = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.equal(page.length, 20);
    assert.ok(page.every((item) => item.votes >= 10000));
    // no sub-1000 item leaked into the output despite floor stepping
    assert.ok(!page.some((item) => item.votes < 1000));
    removeLuna();
  });

  test("dedupes ids repeated across upstream batches", async () => {
    installLuna();
    const batch = [];
    for (let i = 0; i < 60; i++) batch.push(rawItem(i % 30, 500000)); // 30 unique ids, repeated
    responseQueue.push(rexxarResponse(batch));

    const page = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    const ids = new Set(page.map((i) => i.id));
    assert.equal(ids.size, 20);
    removeLuna();
  });

  test("short page at upstream exhaustion, then empty page", async () => {
    installLuna();
    const small = [rawItem(1, 500000), rawItem(2, 400000), rawItem(3, 300000)];
    // Batch 1 is short but NOT empty — rexxar does this mid-pool, so the
    // paginator must keep going. The empty batch is what ends the stream.
    responseQueue.push(rexxarResponse(small), rexxarResponse([]));

    const page1 = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.equal(page1.length, 3);
    assert.equal(serviceCalls.length, 2);

    const page2 = await getRecommendPage("movie", { sort: "S", start: 3 }, 20);
    assert.equal(page2.length, 0);
    removeLuna();
  });

  test("offset mismatch falls back (returns null)", async () => {
    installLuna();
    const batch = [];
    for (let i = 0; i < 60; i++) batch.push(rawItem(i, 500000));
    responseQueue.push(rexxarResponse(batch));

    const page = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.equal(page.length, 20);
    // paginator cursor is at 20; a start=40 call cannot be served directly
    assert.equal(await getRecommendPage("movie", { sort: "S", start: 40 }, 20), null);
    removeLuna();
  });

  test("start=0 on a used paginator replays it instead of failing", async () => {
    installLuna();
    // Two batches: 20 high-vote + filler, then another 20 high-vote.
    const b1 = [], b2 = [];
    for (let i = 0; i < 60; i++) b1.push(rawItem(i, 500000));
    for (let i = 60; i < 120; i++) b2.push(rawItem(i, 500000));
    responseQueue.push(rexxarResponse(b1), rexxarResponse(b2), rexxarResponse(b1));

    const page1 = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.equal(page1.length, 20);
    // Re-enter the same filter (e.g. user scrolled, left, came back):
    // served=20 ≠ start=0 used to return null — which now surfaces as
    // DOUBAN_DIRECT_UNAVAILABLE. It must reset and replay instead.
    const replay = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.ok(Array.isArray(replay));
    assert.equal(replay.length, 20); // refilled from upstream, full page
    assert.ok(replay.every((item) => item.votes >= 10000));
    removeLuna();
  });

  test("fresh module with start>0 falls back (no mid-stream join)", async () => {
    installLuna();
    assert.equal(await getRecommendPage("movie", { sort: "S", start: 40 }, 20), null);
    assert.equal(serviceCalls.length, 0);
    removeLuna();
  });
});

// ── circuit breaker ───────────────────────────────────────────────────────

describe("circuit breaker", () => {
  test("opens after 3 consecutive failures and skips direct for a while", async () => {
    installLuna();
    responseQueue.push(new Error("NET_1"), new Error("NET_2"), new Error("NET_3"));
    for (let i = 0; i < 3; i++) {
      assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
    }
    assert.equal(serviceCalls.length, 3);

    // Breaker open: this call must not even reach the service.
    assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
    assert.equal(serviceCalls.length, 3);
    removeLuna();
  });

  test("a success resets the failure counter", async () => {
    installLuna();
    const batch = [];
    for (let i = 0; i < 60; i++) batch.push(rawItem(i, 500000));
    // Distinct query keys per call so each failure gets a fresh paginator
    // (a failed paginator is reset, and its next call at the same offset
    // would serve from the previous buffer instead of hitting the network).
    responseQueue.push(new Error("NET_1"), new Error("NET_2"), rexxarResponse(batch),
      new Error("NET_3"), new Error("NET_4"), new Error("NET_5"));

    const q = (region, extra = {}) => ({ region, sort: "S", start: 0, ...extra });
    assert.equal(await getRecommendPage("movie", q("华语"), 20), null);      // fail 1
    assert.equal(await getRecommendPage("movie", q("华语"), 20), null);      // fail 2
    const page = await getRecommendPage("movie", q("美国"), 20);            // success → reset
    assert.equal(page.length, 20);
    // Two more failures after the success: only 2 in a row, breaker NOT open.
    assert.equal(await getRecommendPage("movie", q("日本"), 20), null);      // fail 1 again
    assert.equal(await getRecommendPage("movie", q("韩国"), 20), null);      // fail 2 again
    // A sixth call still reaches the service (breaker open would skip it).
    assert.equal(await getRecommendPage("movie", q("英国"), 20), null);
    assert.equal(serviceCalls.length, 6);
    removeLuna();
  });
});

// ── recent_hot (replaces server /api/douban/categories) ───────────────────

function recentHotResponse(items) {
  return {
    returnValue: true,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ total: items.length, items })
  };
}

describe("getRecentHotPage", () => {
  test("hits the rexxar recent_hot path and maps votes", async () => {
    installLuna();
    responseQueue.push(recentHotResponse([
      { id: "1", title: "番剧A", type: "tv",
        pic: { normal: "https://img.doubanio.com/p1.jpg" },
        rating: { value: 8.8, count: 6421 },
        card_subtitle: "2026 / 日本 / 动画" }
    ]));

    const list = await getRecentHotPage("tv", "tv", "tv_animation", 0, 24);
    assert.equal(list.length, 1);
    assert.equal(list[0].votes, 6421);
    assert.equal(list[0].rate, "8.8");
    // recent_hot items carry no `year` — derived from card_subtitle
    assert.equal(list[0].year, "2026");
    assert.ok(serviceCalls[0].parameters.path.includes("/rexxar/api/v2/subject/recent_hot/tv"));
    assert.ok(serviceCalls[0].parameters.path.includes("category=tv"));
    assert.ok(serviceCalls[0].parameters.path.includes("type=tv_animation"));
    removeLuna();
  });

  test("throws without Luna transport", async () => {
    removeLuna();
    await assert.rejects(() => getRecentHotPage("tv", "tv", "tv_animation"), /DOUBAN_UNAVAILABLE/);
  });

  test("throws on bad shape and feeds the breaker", async () => {
    installLuna();
    responseQueue.push({ returnValue: true, status: 200, body: "{}" });
    await assert.rejects(() => getRecentHotPage("tv", "tv", "show"), /DOUBAN_BAD_SHAPE/);
    removeLuna();
  });
});

// ── subject_collection (replaces server /api/douban?type&tag) ─────────────

function collectionResponse(items) {
  return {
    returnValue: true,
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ total: items.length, subject_collection_items: items })
  };
}

describe("getChartPage", () => {
  test("热门电影 maps to movie_hot_gaia and maps cover.url items", async () => {
    installLuna();
    responseQueue.push(collectionResponse([
      { id: "5", title: "热门片", type: "movie",
        cover: { url: "https://img.doubanio.com/c5.jpg" },
        rating: { value: 7.3, count: 50021 },
        card_subtitle: "2026 / 中国大陆 / 剧情" }
    ]));

    const list = await getChartPage("movie", "热门", 0, 24);
    assert.equal(list.length, 1);
    assert.equal(list[0].votes, 50021);
    assert.equal(list[0].poster, "https://img.doubanio.com/c5.jpg");
    assert.ok(serviceCalls[0].parameters.path.includes("/rexxar/api/v2/subject_collection/movie_hot_gaia/items"));
    removeLuna();
  });

  test("热门剧集 maps to tv_hot", async () => {
    installLuna();
    responseQueue.push(collectionResponse([]));
    await getChartPage("tv", "热门", 0, 24);
    assert.ok(serviceCalls[0].parameters.path.includes("/subject_collection/tv_hot/items"));
    removeLuna();
  });

  test("unmapped type+tag combos throw before hitting the network", async () => {
    installLuna();
    await assert.rejects(() => getChartPage("movie", "冷门佳片"), /DOUBAN_NO_CHART/);
    assert.equal(serviceCalls.length, 0);
    removeLuna();
  });

  test("throws without Luna transport", async () => {
    removeLuna();
    await assert.rejects(() => getChartPage("movie", "热门"), /DOUBAN_UNAVAILABLE/);
  });
});
