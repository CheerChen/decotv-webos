import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildRecommendPath,
  mapRexxarItem,
  getRecommendPage,
  pickVoteFloor,
  getRecentHotPage,
  getChartPage,
  _resetForTest
} from "../js/core/network/doubanDirect.js";

// ── harness: fake the webOS Luna bus ──────────────────────────────────────

let serviceCalls = [];
let responseQueue = [];
// Optional path -> response|Error function; takes precedence over the queue.
// Recommend loads fire their chunks in parallel, so they are answered by
// path (the chunk's start/count) rather than by call order.
let responder = null;

function installLuna() {
  serviceCalls = [];
  responseQueue = [];
  responder = null;
  globalThis.window = {
    webOS: {
      service: {
        request(uri, options) {
          serviceCalls.push({ uri, method: options.method, parameters: options.parameters });
          const next = responder ? responder(options.parameters.path) : responseQueue.shift();
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

// Serve `pool` as rexxar would: each chunk is the slice at its start/count.
function servePool(pool) {
  responder = (path) => {
    const q = new URLSearchParams(path.split("?")[1]);
    const start = Number(q.get("start"));
    return rexxarResponse(pool.slice(start, start + Number(q.get("count"))));
  };
}

// One load = one parallel round of chunk requests.
const CHUNKS_PER_LOAD = 5;

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

describe("pickVoteFloor", () => {
  const withVotes = (...votes) => votes.map((v, i) => ({ id: String(i), votes: v }));

  test("keeps the strictest step that still fills a page", () => {
    assert.equal(pickVoteFloor(withVotes(20000, 20000, 500), 2), 10000);
    assert.equal(pickVoteFloor(withVotes(20000, 5000, 500), 2), 3000);
    assert.equal(pickVoteFloor(withVotes(20000, 1500, 500), 2), 1000);
  });

  test("never goes below the last step", () => {
    assert.equal(pickVoteFloor(withVotes(500, 400), 2), 1000);
    assert.equal(pickVoteFloor([], 20), 1000);
  });
});

describe("getRecommendPage", () => {
  test("returns null without Luna transport (browser dev falls back)", async () => {
    removeLuna();
    assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
  });

  test("one parallel round of chunks serves every page of a query", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 70; i++) pool.push(rawItem(i, 500000));
    servePool(pool);

    const q = (start) => ({ region: "日本", year: "2025", sort: "S", start });
    const pages = [];
    for (const start of [0, 20, 40, 60, 70]) {
      pages.push(await getRecommendPage("movie", q(start), 20));
    }
    assert.deepEqual(pages.map((p) => p.length), [20, 20, 20, 10, 0]);
    // Fixed offsets covering rexxar's 500-item cap, nothing after.
    const chunks = serviceCalls.map((c) => {
      const q = new URLSearchParams(c.parameters.path.split("?")[1]);
      return `${q.get("start")}+${q.get("count")}`;
    });
    assert.deepEqual(chunks, ["0+100", "100+100", "200+100", "300+100", "400+100"]);
    assert.deepEqual(pages.flat().map((i) => i.id), pool.map((i) => i.id));
    removeLuna();
  });

  test("vote floor filters low-vote items out of sort=S pages", async () => {
    installLuna();
    // Alternating high/low votes: 30 of 60 clear 10k, enough for a page.
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i, i % 2 === 0 ? 500000 : 3000));
    servePool(pool);

    const page1 = await getRecommendPage("movie", { region: "华语", sort: "S", start: 0 }, 20);
    const page2 = await getRecommendPage("movie", { region: "华语", sort: "S", start: 20 }, 20);
    assert.equal(page1.length, 20);
    assert.equal(page2.length, 10);
    for (const item of page1.concat(page2)) {
      assert.ok(item.votes >= 10000, `votes ${item.votes} passed the floor`);
    }
    removeLuna();
  });

  test("a narrow query gets every item above the looser floor", async () => {
    installLuna();
    // 13 items clear 10k (short of a page), 24 more sit at 3k-10k, the rest
    // below 1k. The floor drops to 3k over the WHOLE pool: all 37 survive,
    // in upstream order — the 3k-10k items are not lost to an earlier,
    // stricter pass.
    const pool = [];
    for (let i = 0; i < 13; i++) pool.push(rawItem(i, 50000));
    for (let i = 13; i < 37; i++) pool.push(rawItem(i, 5000));
    for (let i = 37; i < 200; i++) pool.push(rawItem(i, 300));
    pool.sort((a, b) => (Number(a.id) * 7919) % 200 - (Number(b.id) * 7919) % 200);
    servePool(pool);

    const q = (start) => ({ region: "日本", year: "2025", sort: "S", start });
    const served = [];
    for (const start of [0, 20, 40]) served.push(...await getRecommendPage("movie", q(start), 20));
    assert.equal(served.length, 37);
    assert.ok(served.every((item) => item.votes >= 3000));
    assert.deepEqual(served.map((i) => i.id),
      pool.filter((i) => i.rating.count >= 3000).map((i) => i.id));
    assert.equal(serviceCalls.length, CHUNKS_PER_LOAD);
    removeLuna();
  });

  test("non-S sorts pass through without vote filtering", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 25; i++) pool.push(rawItem(i, 12));
    servePool(pool);

    const page = await getRecommendPage("movie", { sort: "U", start: 0 }, 20);
    assert.equal(page.length, 20);
    assert.equal(page[0].votes, 12);
    removeLuna();
  });

  test("dedupes repeated ids and drops non-movie/tv items", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i % 30, 500000)); // 30 unique ids, repeated
    pool.push({ id: "x", type: "doulist", title: "list" });
    servePool(pool);

    const page1 = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    const page2 = await getRecommendPage("movie", { sort: "S", start: 20 }, 20);
    const ids = page1.concat(page2).map((i) => i.id);
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
    removeLuna();
  });

  test("revisiting a query serves from the pool without a request", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i, 500000));
    servePool(pool);

    const page1 = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    await getRecommendPage("movie", { sort: "S", start: 20 }, 20);
    const replay = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.deepEqual(replay, page1);
    assert.equal(serviceCalls.length, CHUNKS_PER_LOAD);
    removeLuna();
  });

  test("a first call at start>0 loads the pool and serves that offset", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i, 500000));
    servePool(pool);

    const page = await getRecommendPage("movie", { sort: "S", start: 40 }, 20);
    assert.deepEqual(page.map((i) => i.id), pool.slice(40, 60).map((i) => i.id));
    assert.equal(serviceCalls.length, CHUNKS_PER_LOAD);
    removeLuna();
  });

  test("concurrent calls for one query share a single request", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i, 500000));
    servePool(pool);

    const [a, b] = await Promise.all([
      getRecommendPage("movie", { sort: "S", start: 0 }, 20),
      getRecommendPage("movie", { sort: "S", start: 20 }, 20),
    ]);
    assert.equal(a.length, 20);
    assert.equal(b.length, 20);
    assert.equal(serviceCalls.length, CHUNKS_PER_LOAD);
    removeLuna();
  });

  test("a failed load is retried on the next call", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i, 500000));
    servePool(pool);
    const serve = responder;
    // One chunk of the first load fails: the whole load fails (no partial
    // pool), and the next call starts a fresh round.
    let failed = false;
    responder = (path) => {
      if (!failed && path.includes("start=200")) { failed = true; return new Error("NET_1"); }
      return serve(path);
    };

    assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
    const page = await getRecommendPage("movie", { sort: "S", start: 0 }, 20);
    assert.equal(page.length, 20);
    assert.equal(serviceCalls.length, 2 * CHUNKS_PER_LOAD);
    removeLuna();
  });

  test("pools are evicted least-recently-used first", async () => {
    installLuna();
    servePool([rawItem(1, 500000)]);
    const loads = () => serviceCalls.length / CHUNKS_PER_LOAD;

    const q = (year) => ({ year: String(year), sort: "S", start: 0 });
    for (let y = 2000; y < 2012; y++) await getRecommendPage("movie", q(y), 20); // 12 pools
    await getRecommendPage("movie", q(2000), 20); // touch the oldest: no request
    assert.equal(loads(), 12);
    await getRecommendPage("movie", q(2012), 20); // 13th evicts 2001, not 2000
    await getRecommendPage("movie", q(2000), 20);
    assert.equal(loads(), 13);
    await getRecommendPage("movie", q(2001), 20);
    assert.equal(loads(), 14);
    removeLuna();
  });
});

// ── circuit breaker ───────────────────────────────────────────────────────

describe("circuit breaker", () => {
  // A load whose chunks all fail counts as ONE failure, however many
  // chunk requests it fired.
  const failAll = () => { responder = () => new Error("NET"); };
  const loads = () => serviceCalls.length / CHUNKS_PER_LOAD;

  test("opens after 3 consecutive failures and skips direct for a while", async () => {
    installLuna();
    failAll();
    for (let i = 0; i < 3; i++) {
      assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
    }
    assert.equal(loads(), 3);

    // Breaker open: this call must not even reach the service.
    assert.equal(await getRecommendPage("movie", { sort: "S", start: 0 }, 20), null);
    assert.equal(loads(), 3);
    removeLuna();
  });

  test("a success resets the failure counter", async () => {
    installLuna();
    const pool = [];
    for (let i = 0; i < 60; i++) pool.push(rawItem(i, 500000));
    const q = (region) => ({ region, sort: "S", start: 0 });

    failAll();
    assert.equal(await getRecommendPage("movie", q("华语"), 20), null);      // fail 1
    assert.equal(await getRecommendPage("movie", q("华语"), 20), null);      // fail 2
    servePool(pool);
    const page = await getRecommendPage("movie", q("美国"), 20);            // success → reset
    assert.equal(page.length, 20);
    // Two more failures after the success: only 2 in a row, breaker NOT open.
    failAll();
    assert.equal(await getRecommendPage("movie", q("日本"), 20), null);      // fail 1 again
    assert.equal(await getRecommendPage("movie", q("韩国"), 20), null);      // fail 2 again
    // A sixth load still reaches the service (breaker open would skip it).
    assert.equal(await getRecommendPage("movie", q("英国"), 20), null);
    assert.equal(loads(), 6);
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
