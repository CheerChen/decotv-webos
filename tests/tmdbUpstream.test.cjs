const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  credentialFor,
  loadCredential,
  tmdbTargetFor,
  upstreamRequest,
  cacheable
} = require("../service/com.cheerchen.decotv.service/tmdbUpstream.js");

describe("TMDB upstream policy", () => {
  test("a JWT read token becomes a Bearer header, anything else an api_key", () => {
    assert.deepEqual(credentialFor("aaa.bbb.ccc\n"), { type: "bearer", value: "aaa.bbb.ccc" });
    assert.deepEqual(credentialFor(" 0123abcd "), { type: "api_key", value: "0123abcd" });
    assert.equal(credentialFor("  \n"), null);
  });

  test("a missing key file yields no credential instead of throwing", () => {
    assert.equal(loadCredential(path.join(os.tmpdir(), "decotv-no-such-tmdb.key")), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decotv-tmdb-"));
    const file = path.join(dir, "tmdb.key");
    fs.writeFileSync(file, "k123\n");
    assert.deepEqual(loadCredential(file), { type: "api_key", value: "k123" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("only relative /3/ paths on the TMDB origin are accepted", () => {
    assert.equal(tmdbTargetFor("/3/trending/movie/week?page=1").pathname, "/3/trending/movie/week");
    assert.throws(() => tmdbTargetFor("https://evil.test/3/x"), /relative path/);
    assert.throws(() => tmdbTargetFor("//evil.test/3/x"), /relative path/);
    assert.throws(() => tmdbTargetFor("/4/list/1"), /\/3\//);
    assert.throws(() => tmdbTargetFor(undefined), /relative path/);
  });

  test("a page-supplied api_key is stripped and the bundled one appended", () => {
    const target = tmdbTargetFor("/3/discover/movie?page=2&api_key=attacker");
    const req = upstreamRequest(target, { type: "api_key", value: "bundled" });
    assert.equal(req.cacheKey, "/3/discover/movie?page=2");
    assert.equal(req.path, "/3/discover/movie?page=2&api_key=bundled");
    assert.equal(req.headers.Authorization, undefined);
  });

  test("a bearer credential stays out of the path and the cache key", () => {
    const target = tmdbTargetFor("/3/movie/1/images");
    const req = upstreamRequest(target, { type: "bearer", value: "a.b.c" });
    assert.equal(req.path, "/3/movie/1/images");
    assert.equal(req.cacheKey, "/3/movie/1/images");
    assert.equal(req.headers.Authorization, "Bearer a.b.c");
  });

  test("list responses are cached, per-title image listings are not", () => {
    assert.equal(cacheable(tmdbTargetFor("/3/discover/tv?page=1")), true);
    assert.equal(cacheable(tmdbTargetFor("/3/tv/42/images?language=en-US")), false);
  });
});
