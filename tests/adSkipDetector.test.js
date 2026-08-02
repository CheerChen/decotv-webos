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
import { parseMediaGroups, firstVariantUrl } from "../js/core/playback/adSkipScanner.js";

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
});
