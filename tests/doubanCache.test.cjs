// Tests for the service-side Douban JSON TTL cache (CommonJS, runs on plain
// node --test like the other .cjs service tests).

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { DoubanCache } = require("../service/com.cheerchen.decotv.service/doubanCache.js");

describe("DoubanCache", () => {
  test("stores and returns JSON bodies", () => {
    const cache = new DoubanCache(60000, 10);
    cache.set("/rexxar/api/v2/movie/recommend?start=0", "{\"total\":500}");
    assert.equal(cache.get("/rexxar/api/v2/movie/recommend?start=0"), "{\"total\":500}");
    assert.equal(cache.size(), 1);
  });

  test("misses on unknown keys and after TTL expiry", async () => {
    const cache = new DoubanCache(5, 10);
    cache.set("/k", "v");
    assert.equal(cache.get("/k"), "v");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cache.get("/k"), null);
    assert.equal(cache.size(), 0);
    assert.equal(cache.get("/never-set"), null);
  });

  test("evicts the least recently used entry past maxEntries", () => {
    const cache = new DoubanCache(60000, 2);
    cache.set("/a", "1");
    cache.set("/b", "2");
    assert.equal(cache.get("/a"), "1"); // touch /a → /b is now oldest
    cache.set("/c", "3");               // evicts /b
    assert.equal(cache.get("/b"), null);
    assert.equal(cache.get("/a"), "1");
    assert.equal(cache.get("/c"), "3");
    assert.equal(cache.size(), 2);
  });

  test("overwriting a key does not grow the cache", () => {
    const cache = new DoubanCache(60000, 5);
    cache.set("/a", "1");
    cache.set("/a", "2");
    assert.equal(cache.size(), 1);
    assert.equal(cache.get("/a"), "2");
  });

  test("clear empties everything", () => {
    const cache = new DoubanCache(60000, 5);
    cache.set("/a", "1");
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.equal(cache.get("/a"), null);
  });
});
