// test/sourceRanking.test.js — tests for pure ranking functions.
// Run: node --test tests/sourceRanking.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getQualityRank,
  hasMeasuredMediaThroughput,
  isVerifiedPlaybackResult,
  isPlayableFallbackResult,
  getPlaybackEvidenceTier,
  comparePlaybackMetrics,
  getSourceProbeKey,
} from "../js/core/network/sourceRanking.js";

describe("getQualityRank", () => {
  test("parses standard resolution labels", () => {
    assert.equal(getQualityRank({ quality: "1080p" }), 1080);
    assert.equal(getQualityRank({ quality: "720p" }), 720);
    assert.equal(getQualityRank({ quality: "480p" }), 480);
  });

  test("handles 4K / UHD", () => {
    assert.equal(getQualityRank({ quality: "4K" }), 2160);
    assert.equal(getQualityRank({ quality: "UHD" }), 2160);
    assert.equal(getQualityRank({ quality: "2160p" }), 2160);
  });

  test("handles missing or unparseable quality", () => {
    assert.equal(getQualityRank(null), 0);
    assert.equal(getQualityRank({}), 0);
    assert.equal(getQualityRank({ quality: "" }), 0);
    assert.equal(getQualityRank({ quality: "未知" }), 0);
  });

  test("handles dimension strings like 1920x1080 (extracts first number)", () => {
    // The regex extracts the first 3-4 digit number, so 1920x1080 → 1920.
    assert.equal(getQualityRank({ quality: "1920x1080" }), 1920);
  });
});

describe("hasMeasuredMediaThroughput", () => {
  test("true when speedKBps > 0 and no error", () => {
    assert.equal(hasMeasuredMediaThroughput({ speedKBps: 500 }), true);
  });

  test("false when hasError", () => {
    assert.equal(hasMeasuredMediaThroughput({ speedKBps: 500, hasError: true }), false);
  });

  test("false when speedKBps is 0 or missing", () => {
    assert.equal(hasMeasuredMediaThroughput({ speedKBps: 0 }), false);
    assert.equal(hasMeasuredMediaThroughput({}), false);
    assert.equal(hasMeasuredMediaThroughput(null), false);
  });
});

describe("isVerifiedPlaybackResult", () => {
  test("verified when has measured throughput", () => {
    assert.equal(isVerifiedPlaybackResult({ speedKBps: 500 }), true);
  });

  test("verified when status ok + playable", () => {
    assert.equal(isVerifiedPlaybackResult({ status: "ok", playable: true }), true);
  });

  test("not verified when hasError", () => {
    assert.equal(isVerifiedPlaybackResult({ speedKBps: 500, hasError: true }), false);
  });

  test("not verified when no throughput and not ok+playable", () => {
    assert.equal(isVerifiedPlaybackResult({ status: "partial" }), false);
    assert.equal(isVerifiedPlaybackResult(null), false);
  });
});

describe("isPlayableFallbackResult", () => {
  test("true for verified results", () => {
    assert.equal(isPlayableFallbackResult({ speedKBps: 500 }), true);
  });

  test("false for page mediaType", () => {
    assert.equal(isPlayableFallbackResult({ mediaType: "page" }), false);
  });

  test("false for hasError", () => {
    assert.equal(isPlayableFallbackResult({ hasError: true }), false);
  });

  test("false for resolver/timeout/manifest/network failureKind", () => {
    assert.equal(isPlayableFallbackResult({ status: "partial", failureKind: "resolver" }), false);
    assert.equal(isPlayableFallbackResult({ status: "partial", failureKind: "timeout" }), false);
    assert.equal(isPlayableFallbackResult({ status: "partial", failureKind: "manifest" }), false);
    assert.equal(isPlayableFallbackResult({ status: "partial", failureKind: "network" }), false);
  });

  test("true for partial + fragment failureKind", () => {
    assert.equal(isPlayableFallbackResult({ status: "partial", failureKind: "fragment" }), true);
  });

  test("true for partial + playable", () => {
    assert.equal(isPlayableFallbackResult({ status: "partial", playable: true }), true);
  });
});

describe("comparePlaybackMetrics", () => {
  test("higher quality wins regardless of speed", () => {
    const a = { quality: "1080p", speedKBps: 100 };
    const b = { quality: "720p", speedKBps: 999 };
    assert.ok(comparePlaybackMetrics(a, b) < 0); // a is better (higher res)
  });

  test("same quality, higher speed wins", () => {
    const a = { quality: "1080p", speedKBps: 200 };
    const b = { quality: "1080p", speedKBps: 500 };
    assert.ok(comparePlaybackMetrics(a, b) > 0); // b is better (faster)
  });

  test("verified beats failed", () => {
    const a = { speedKBps: 100 };
    const b = { hasError: true, status: "failed" };
    assert.ok(comparePlaybackMetrics(a, b) < 0); // a is better
  });

  test("null inputs return 0", () => {
    assert.equal(comparePlaybackMetrics(null, null), 0);
  });

  test("lower pingTime wins as tie-breaker", () => {
    const a = { quality: "1080p", speedKBps: 500, pingTime: 50 };
    const b = { quality: "1080p", speedKBps: 500, pingTime: 100 };
    assert.ok(comparePlaybackMetrics(a, b) < 0); // a has lower ping
  });
});

describe("getSourceProbeKey", () => {
  test("builds source-id key", () => {
    assert.equal(getSourceProbeKey({ source: "jszyapi.com", id: 61361 }), "jszyapi.com-61361");
  });
});
