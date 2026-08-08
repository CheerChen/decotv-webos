// tests/adSkipDetector.test.js
// Run: node --test tests/adSkipDetector.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initialAdSkipState,
  isAdResolution,
  observeAdSkip,
  applyScanResult,
  markScanRunning,
  BASELINE_STABLE_SAMPLES,
  MIN_BASELINE_TIME_S,
  SKIP_STEP_S
} from "../js/core/playback/adSkipDetector.js";
import {
  parseMediaGroups,
  firstVariantUrl,
  scanAdRanges,
  urlSignature
} from "../js/core/playback/adSkipScanner.js";

function sample(partial) {
  return {
    w: 1920,
    h: 1080,
    currentTime: 10,
    duration: 1400,
    paused: false,
    seeking: false,
    ended: false,
    now: 1_000_000,
    ...partial
  };
}

describe("isAdResolution", () => {
  it("flags 848x640 against 1080p", () => {
    assert.equal(isAdResolution(848, 640, 1920, 1080), true);
  });
  it("does not flag same resolution", () => {
    assert.equal(isAdResolution(1920, 1080, 1920, 1080), false);
  });
});

describe("pre-scan range skip", () => {
  it("seeks once to range end when entering an ad window", () => {
    let s = applyScanResult(initialAdSkipState(), {
      ranges: [{ start: 496, end: 537 }],
      baseline: { w: 1920, h: 1080 },
      elapsedMs: 100
    });
    assert.equal(s.scanStatus, "done");
    assert.equal(s.ranges.length, 1);

    let r = observeAdSkip(s, sample({ currentTime: 496.2, w: 848, h: 640 }));
    assert.equal(r.action?.type, "seek");
    assert.equal(r.action.to, 537);
    assert.match(r.action.toast || "", /广告/);
    s = r.state;

    // Same range not jumped again
    r = observeAdSkip(s, sample({ currentTime: 500, w: 848, h: 640 }));
    assert.equal(r.action, null);
  });

  it("does not fire before the ad range", () => {
    const s = applyScanResult(initialAdSkipState(), {
      ranges: [{ start: 496, end: 537 }],
      baseline: { w: 1920, h: 1080 }
    });
    const r = observeAdSkip(s, sample({ currentTime: 400 }));
    assert.equal(r.action, null);
  });
});

describe("live fallback when no ranges", () => {
  function lockBaseline(state) {
    let s = state;
    for (let i = 0; i < BASELINE_STABLE_SAMPLES; i++) {
      const r = observeAdSkip(s, sample({
        currentTime: MIN_BASELINE_TIME_S + 1 + i * 0.5,
        now: 1_000_000 + i
      }));
      s = r.state;
    }
    return s;
  }

  it("still step-seeks when scan found nothing", () => {
    let s = markScanRunning(initialAdSkipState());
    s = applyScanResult(s, { ranges: [], baseline: { w: 1920, h: 1080 } });
    // applyScanResult with baseline locks; ranges empty → live path
    s = { ...s, locked: false, baselineW: 0, baselineH: 0, stableCount: 0 };
    s = lockBaseline(s);
    const r = observeAdSkip(s, sample({
      w: 848, h: 640, currentTime: 496, now: 2_000_000
    }));
    assert.equal(r.action?.type, "seek");
    assert.equal(r.action.to, 496 + SKIP_STEP_S);
  });
});

describe("parseMediaGroups", () => {
  it("splits on discontinuity and tracks first segment URL", () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:2.0,",
      "https://cdn.example/a0.ts",
      "#EXTINF:2.0,",
      "https://cdn.example/a1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.example/ad0.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.example/b0.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
    const groups = parseMediaGroups(text, "https://cdn.example/index.m3u8");
    assert.equal(groups.length, 3);
    assert.equal(groups[0].start, 0);
    assert.equal(groups[0].duration, 4);
    assert.equal(groups[1].firstUrl, "https://cdn.example/ad0.ts");
    assert.equal(groups[1].start, 4);
    assert.equal(groups[1].duration, 2);
    assert.equal(groups[2].start, 6);
  });

  it("finds first variant on master playlists", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000",
      "2000k/index.m3u8"
    ].join("\n");
    assert.equal(
      firstVariantUrl(text, "https://cdn.example/master.m3u8"),
      "https://cdn.example/2000k/index.m3u8"
    );
  });

  it("computes a per-group URL signature from segment directories", () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:2.0,",
      "https://cdn.example/ep/s1.ts",
      "#EXTINF:2.0,",
      "https://cdn.example/ep/s2.ts?token=1",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.example/ads/creative/a1.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
    const groups = parseMediaGroups(text, "https://cdn.example/index.m3u8");
    assert.equal(groups.length, 2);
    // Query strings and filenames are stripped; only host + dir remain.
    assert.equal(groups[0].sig, "https://cdn.example/ep/");
    assert.equal(groups[1].sig, "https://cdn.example/ads/creative/");
  });

  it("returns null signature when a group spans mixed directories", () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:2.0,",
      "https://cdn.example/a/s1.ts",
      "#EXTINF:2.0,",
      "https://cdn.example/b/s2.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
    const groups = parseMediaGroups(text, "https://cdn.example/index.m3u8");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].sig, null);
  });
});

describe("scanAdRanges URL-signature feature", () => {
  // Real H.264 SPS extracted from an ad segment that encodes at 1920x1080
  // (High profile, level 4.0). Verified to parse via resolutionFromTsBuffer.
  const SPS_1080P = new Uint8Array([
    0x00, 0x00, 0x00, 0x01,
    0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5,
    0xc0, 0x5a, 0x80, 0x80, 0x80, 0xa0, 0x00, 0x00, 0x03, 0x00, 0x20,
    0x00, 0x00, 0x06, 0x41, 0xe3, 0x06, 0x32, 0xc0
  ]);

  function stubFetch(playlistText, segmentBody) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (/\.m3u8/.test(s)) {
        return new Response(playlistText, { status: 200 });
      }
      return new Response(segmentBody, { status: 200 });
    };
    return () => {
      globalThis.fetch = original;
    };
  }

  const playlist = [
    "#EXTM3U",
    "#EXTINF:4.0,",
    "https://cdn.example/2025/1107/4M/hls/s1.ts",
    "#EXTINF:4.0,",
    "https://cdn.example/2025/1107/4M/hls/s2.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:2.0,",
    "https://cdn.example/20260727/creative/10M/hls/a1.ts",
    "#EXTINF:2.0,",
    "https://cdn.example/20260727/creative/10M/hls/a2.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:4.0,",
    "https://cdn.example/2025/1107/4M/hls/s3.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");

  it("flags an ad group whose URL signature differs even at the same resolution", async () => {
    const restore = stubFetch(playlist, SPS_1080P);
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      // Both content and ad probe as 1920x1080 — resolution alone would find
      // nothing; the URL signature must carry the classification.
      assert.equal(result.baseline.w, 1920);
      assert.equal(result.baseline.h, 1080);
      assert.deepEqual(result.ranges, [{ start: 8, end: 12 }]);
      assert.equal(result.sigAdGroups, 1);
    } finally {
      restore();
    }
  });

  it("flags a deviant URL signature even when every segment probe fails", async () => {
    const restore = stubFetch(playlist, new Uint8Array([1, 2, 3]));
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      assert.equal(result.probed, 0);
      assert.equal(result.baseline, null);
      assert.deepEqual(result.ranges, [{ start: 8, end: 12 }]);
      assert.equal(result.sigAdGroups, 1);
    } finally {
      restore();
    }
  });

  it("returns no ranges when all groups share one URL signature", async () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:4.0,",
      "https://cdn.example/ep/s1.ts",
      "#EXTINF:4.0,",
      "https://cdn.example/ep/s2.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
    const restore = stubFetch(text, SPS_1080P);
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      assert.deepEqual(result.ranges, []);
    } finally {
      restore();
    }
  });

  it("urlSignature strips filenames and query strings", () => {
    assert.equal(
      urlSignature("https://cdn.example/2025/1107/4M/hls/a.ts?token=abc"),
      "https://cdn.example/2025/1107/4M/hls/"
    );
    assert.equal(urlSignature("not a url"), null);
  });
});
