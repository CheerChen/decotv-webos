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

// Real H.264 SPS snippets (start code + NAL), verified to parse via
// resolutionFromTsBuffer: 1920x1080 ad material, 1280x720 content, and
// 2542x1080 letterboxed 2.35:1 content (zuidazym3u8 family).
const SPS_1080P = new Uint8Array([
  0x00, 0x00, 0x00, 0x01,
  0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5,
  0xc0, 0x5a, 0x80, 0x80, 0x80, 0xa0, 0x00, 0x00, 0x03, 0x00, 0x20,
  0x00, 0x00, 0x06, 0x41, 0xe3, 0x06, 0x32, 0xc0
]);
const SPS_720P = new Uint8Array([
  0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50,
  0x05, 0xbb, 0x01, 0x6a, 0x02, 0x02, 0x02, 0x80, 0x00, 0x00, 0x03, 0x00,
  0x80, 0x00, 0x00, 0x19, 0x07, 0x8c, 0x18, 0xcb
]);
const SPS_2542X1080 = new Uint8Array([
  0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x32, 0xac, 0xd9, 0x40, 0x27,
  0xc0, 0x89, 0xea, 0x5c, 0x05, 0xa8, 0x48, 0x80, 0x4a, 0x00, 0x00, 0x03,
  0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x64, 0x1e, 0x30, 0x63, 0x2c
]);

function stubFetch(playlistText, resolveBody) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (/\.m3u8/.test(s)) {
      return new Response(playlistText, { status: 200 });
    }
    const body = typeof resolveBody === "function" ? resolveBody(s) : resolveBody;
    return new Response(body, { status: 200 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

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
  it("flags smaller resolution (848x640 against 1080p)", () => {
    assert.equal(isAdResolution(848, 640, 1920, 1080), true);
  });
  it("flags larger resolution (1080p ad injected into 720p rip)", () => {
    assert.equal(isAdResolution(1920, 1080, 1280, 720), true);
  });
  it("flags 16:9 1080p block against 2.35:1 2542x1080 content", () => {
    assert.equal(isAdResolution(1920, 1080, 2542, 1080), true);
  });
  it("does not flag same resolution", () => {
    assert.equal(isAdResolution(1920, 1080, 1920, 1080), false);
  });
  it("does not flag when baseline is empty", () => {
    assert.equal(isAdResolution(1920, 1080, 0, 0), false);
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
    "#EXTINF:2.0,",
    "https://cdn.example/20260727/creative/10M/hls/a3.ts",
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
      // nothing; the URL signature must carry the classification. Ad block is
      // 3x2s = 6s and survives the MIN_AD_RANGE_S=5 floor.
      assert.equal(result.baseline.w, 1920);
      assert.equal(result.baseline.h, 1080);
      assert.deepEqual(result.ranges, [{ start: 8, end: 14 }]);
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
      assert.deepEqual(result.ranges, [{ start: 8, end: 14 }]);
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

describe("scanAdRanges strict coded-resolution rule", () => {
  const sameDirPlaylist = (adCount) => [
    "#EXTM3U",
    "#EXTINF:4.0,",
    "https://cdn.example/ep/hls/s1.ts",
    "#EXTINF:4.0,",
    "https://cdn.example/ep/hls/s2.ts",
    "#EXT-X-DISCONTINUITY",
    ...Array.from({ length: adCount }, (_, i) => [
      "#EXTINF:2.0,",
      `https://cdn.example/ep/hls/ad${i + 1}.ts`
    ]).flat(),
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:4.0,",
    "https://cdn.example/ep/hls/s3.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");

  it("flags a same-directory higher-resolution injection as an ad", async () => {
    const restore = stubFetch(sameDirPlaylist(3), (url) =>
      /ad\d\.ts/.test(url) ? SPS_1080P : SPS_720P);
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      assert.equal(result.baseline.w, 1280);
      assert.equal(result.baseline.h, 720);
      // Same directory as content — URL signature cannot tell the ad apart;
      // the 1920x1080 block must be flagged by strict resolution alone.
      assert.deepEqual(result.ranges, [{ start: 8, end: 14 }]);
      assert.equal(result.sigAdGroups, 0);
    } finally {
      restore();
    }
  });

  it("flags a 16:9 1080p block inside 2542x1080 letterboxed content", async () => {
    const restore = stubFetch(sameDirPlaylist(3), (url) =>
      /ad\d\.ts/.test(url) ? SPS_1080P : SPS_2542X1080);
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      assert.deepEqual(result.ranges, [{ start: 8, end: 14 }]);
    } finally {
      restore();
    }
  });

  it("filters sub-5s resolution anomalies", async () => {
    // A single 2s odd-resolution segment in the same directory must be
    // swallowed by MIN_AD_RANGE_S, not treated as an ad block.
    const text = [
      "#EXTM3U",
      "#EXTINF:4.0,",
      "https://cdn.example/ep/hls/s1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.example/ep/hls/odd1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,",
      "https://cdn.example/ep/hls/s2.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
    const restore = stubFetch(text, (url) =>
      /odd/.test(url) ? SPS_1080P : SPS_2542X1080);
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      assert.deepEqual(result.ranges, []);
    } finally {
      restore();
    }
  });

  it("never flags probe-failed groups on resolution", async () => {
    // The candidate block's first segment has no parseable SPS and shares the
    // content directory — a 512KB partial probe must not misclassify it.
    const restore = stubFetch(sameDirPlaylist(3), (url) =>
      /ad\d\.ts/.test(url) ? new Uint8Array([1, 2, 3]) : SPS_2542X1080);
    try {
      const result = await scanAdRanges("https://cdn.example/index.m3u8");
      assert.equal(result.probed, 2);
      assert.deepEqual(result.ranges, []);
    } finally {
      restore();
    }
  });
});
