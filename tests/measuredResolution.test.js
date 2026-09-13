// measuredResolution.test.js — the client side of the real-resolution read:
// the transport, the ranking evidence order, the autoplay shortcut, and the
// source-row label.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  comparePlaybackMetrics,
  getMeasuredWidth,
  getQualityRank,
} from "../js/core/network/sourceRanking.js";
import { hitsQualityShortcut, runPreferEngine } from "../js/core/network/preferEngine.js";
import {
  readStreamResolution,
  isFullHdMeasured,
  measuredResolutionLabel,
  FULL_HD_WIDTH,
} from "../js/core/playback/streamResolution.js";
import { probeLabel } from "../js/ui/probeLabel.js";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

const source = (name, episodes = ["a"]) => ({
  id: name,
  source: name,
  title: "测试剧集",
  year: "2024",
  episodes,
});

describe("readStreamResolution transport", () => {
  test("reads w/h/level from the service and drops unmeasured answers", async () => {
    const restore = stubFetch(async (url) => {
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:4123\/probe\?url=/);
      return new Response(JSON.stringify({ ok: true, w: 1920, h: 1080, level: 40 }), { status: 200 });
    });
    try {
      assert.deepEqual(
        await readStreamResolution("https://cdn.test/a.m3u8", { port: 4123 }),
        { w: 1920, h: 1080, level: 40 }
      );
    } finally {
      restore();
    }
  });

  test("returns null for an unmeasurable stream, a bad status, or a throw", async () => {
    const cases = [
      async () => new Response(JSON.stringify({ ok: false, error: "no sps" }), { status: 200 }),
      async () => new Response("nope", { status: 404 }),
      async () => { throw new Error("network down"); },
      async () => new Response("{ not json", { status: 200 }),
    ];
    for (const handler of cases) {
      const restore = stubFetch(handler);
      try {
        assert.equal(await readStreamResolution("https://cdn.test/a.m3u8", { port: 4123 }), null);
      } finally {
        restore();
      }
    }
  });

  test("returns null without a port instead of guessing one", async () => {
    // No Luna transport in this environment, so there is no service to ask.
    assert.equal(await readStreamResolution("https://cdn.test/a.m3u8"), null);
  });

  test("gives up on its own timeout", async () => {
    const restore = stubFetch((_url, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener?.("abort", () => reject(new Error("aborted")));
    }));
    try {
      assert.equal(
        await readStreamResolution("https://cdn.test/a.m3u8", { port: 4123, timeoutMs: 20 }),
        null
      );
    } finally {
      restore();
    }
  });

  test("honours a caller abort", async () => {
    const restore = stubFetch((_url, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener?.("abort", () => reject(new Error("aborted")));
    }));
    try {
      const controller = new AbortController();
      const pending = readStreamResolution("https://cdn.test/a.m3u8", {
        port: 4123,
        signal: controller.signal,
      });
      controller.abort();
      assert.equal(await pending, null);
    } finally {
      restore();
    }
  });
});

describe("measured resolution helpers", () => {
  test("a measured width is a number or nothing — never 0-as-quality", () => {
    assert.equal(getMeasuredWidth({ measuredWidth: 1920 }), 1920);
    assert.equal(getMeasuredWidth({ measuredWidth: "1280" }), 1280);
    assert.equal(getMeasuredWidth({}), 0);
    assert.equal(getMeasuredWidth({ measuredWidth: 0 }), 0);
    assert.equal(getMeasuredWidth(null), 0);
  });

  test("full HD means the coded width, not a label", () => {
    assert.equal(isFullHdMeasured({ measuredWidth: 1920 }), true);
    assert.equal(isFullHdMeasured({ measuredWidth: 1900 }), true);
    assert.equal(isFullHdMeasured({ measuredWidth: 1280 }), false);
    // A 1920x608 letterboxed rip is 1920 wide and still not full HD by
    // height — but the width rule is what the label could never express.
    assert.equal(isFullHdMeasured({ measuredWidth: 0 }), false);
    assert.equal(isFullHdMeasured({ quality: "1080p" }), false);
    assert.ok(FULL_HD_WIDTH > 1080);
  });

  test("labels a measured resolution and stays silent when unmeasured", () => {
    assert.equal(measuredResolutionLabel({ measuredWidth: 1920, measuredHeight: 1080 }), "1920×1080");
    assert.equal(measuredResolutionLabel({ quality: "1080p" }), "");
  });
});

describe("ranking evidence order", () => {
  const verified = (extra) => ({ status: "ok", playable: true, speedKBps: 1000, startupTimeMs: 100, ...extra });

  test("a measured width outranks an upstream label", () => {
    // The measured stream really is 1920 wide; the label claims 1080p.
    const measured = verified({ measuredWidth: 1920, measuredHeight: 1080, quality: "480p" });
    const labelled = verified({ quality: "1080p" });
    assert.ok(comparePlaybackMetrics(measured, labelled) < 0);
    assert.equal(getQualityRank(labelled) > getQualityRank(measured), true);
  });

  test("measured evidence outranks an unmeasured label, even a lower measurement", () => {
    // A measured 1280x720 is certain; an unmeasured "1080p" is a claim that
    // is wrong often enough to have been the reason for this work. This is
    // the upstream project's evidence ladder: read > labelled.
    const measured = verified({ measuredWidth: 1280, measuredHeight: 720 });
    const labelled = verified({ quality: "1080p" });
    assert.ok(comparePlaybackMetrics(measured, labelled) < 0);
  });

  test("two measured streams compare on their real widths", () => {
    const full = verified({ measuredWidth: 1920, measuredHeight: 1080, speedKBps: 500 });
    const hd = verified({ measuredWidth: 1280, measuredHeight: 720, speedKBps: 9000 });
    assert.ok(comparePlaybackMetrics(full, hd) < 0);
  });

  test("equal widths fall through to throughput, as before", () => {
    const fast = verified({ measuredWidth: 1920, measuredHeight: 1080, speedKBps: 9000 });
    const slow = verified({ measuredWidth: 1920, measuredHeight: 1080, speedKBps: 500 });
    assert.ok(comparePlaybackMetrics(fast, slow) < 0);
  });

  test("two unmeasured sources still compare on their labels", () => {
    const a = verified({ quality: "1080p", speedKBps: 100 });
    const b = verified({ quality: "720p", speedKBps: 9000 });
    assert.ok(comparePlaybackMetrics(a, b) < 0);
  });
});

describe("autoplay shortcut", () => {
  test("fires on a measured full-HD stream", () => {
    assert.equal(hitsQualityShortcut({ measuredWidth: 1920, measuredHeight: 1080 }), true);
  });

  test("does not fire on a measured stream that is not full HD, whatever its label", () => {
    assert.equal(
      hitsQualityShortcut({ measuredWidth: 1280, measuredHeight: 720, quality: "1080p" }),
      false
    );
  });

  test("falls back to the label when nothing has been measured", () => {
    // Without the service (dev preview, non-webOS) this is all there ever was.
    assert.equal(hitsQualityShortcut({ quality: "1080p" }), true);
    assert.equal(hitsQualityShortcut({ quality: "720p" }), false);
    assert.equal(hitsQualityShortcut({}), false);
  });
});

describe("preferEngine with a resolution reader", () => {
  test("attaches the measured width and starts on measured full HD", async () => {
    const sources = [source("s1", ["a"]), source("s2", ["b"])];
    const picks = [];
    const seen = [];
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      autoPlay: true,
      searchVideos: async () => ({ results: sources }),
      // s1's label claims 480p while the bitstream is 1920x1080; s2 claims
      // 1080p and cannot be measured.
      probePlayback: async (_url, name) => ({
        status: "ok",
        playable: true,
        quality: name === "s1" ? "480p" : "1080p",
        speedKBps: 1000,
        startupTimeMs: 100,
      }),
      measureResolution: async (url) => {
        seen.push(url);
        return url === "a" ? { w: 1920, h: 1080, level: 40 } : null;
      },
      onPick: ({ source: picked }) => picks.push(picked.source),
    });
    assert.deepEqual(seen.sort(), ["a", "b"]);
    assert.equal(result.probeResults.get("s1-s1").measuredWidth, 1920);
    assert.equal(result.probeResults.get("s2-s2").measuredWidth, undefined);
    assert.equal(result.best.source, "s1");
    assert.deepEqual(picks, ["s1"]);
  });

  test("keeps the label shortcut when no reader is injected", async () => {
    const sources = [source("s1", ["a"]), source("s2", ["b"])];
    const picks = [];
    await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      autoPlay: true,
      searchVideos: async () => ({ results: sources }),
      probePlayback: async (_url, name) => ({
        status: "ok",
        playable: true,
        quality: name === "s1" ? "1080p" : "720p",
        speedKBps: 1000,
        startupTimeMs: 100,
      }),
      onPick: ({ source: picked }) => picks.push(picked.source),
    });
    assert.deepEqual(picks, ["s1"]);
  });

  test("a reader that fails or throws leaves the source unmeasured, not failed", async () => {
    const sources = [source("s1", ["a"])];
    let calls = 0;
    const result = await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      searchVideos: async () => ({ results: sources }),
      probePlayback: async () => ({
        status: "ok", playable: true, quality: "720p", speedKBps: 1000, startupTimeMs: 100,
      }),
      measureResolution: async () => { calls += 1; throw new Error("service down"); },
    });
    assert.equal(calls, 1);
    const probe = result.probeResults.get("s1-s1");
    assert.equal(probe.measuredWidth, undefined);
    assert.equal(probe.status, "ok");
    assert.equal(result.best.source, "s1");
  });

  test("does not read a share page the probe could not turn into a stream", async () => {
    const sources = [source("s1", ["a"])];
    let calls = 0;
    await runPreferEngine({
      title: "测试剧集",
      year: "2024",
      searchVideos: async () => ({ results: sources }),
      probePlayback: async () => ({
        status: "partial", mediaType: "page", playable: false, pingTime: 5, message: "share page",
      }),
      measureResolution: async () => { calls += 1; return null; },
    });
    assert.equal(calls, 0);
  });
});

describe("source row copy", () => {
  test("shows the measured resolution instead of the label", () => {
    const label = probeLabel({
      status: "ok",
      playable: true,
      quality: "1080p",
      measuredWidth: 1920,
      measuredHeight: 1080,
      speedKBps: 2048,
      pingTime: 20,
    });
    assert.equal(label.text, "1920×1080 · 2.00 MB/s · 20 ms");
  });

  test("falls back to the label when the stream was not measured", () => {
    const label = probeLabel({
      status: "ok", playable: true, quality: "1080p", speedKBps: 2048, pingTime: 20,
    });
    assert.equal(label.text, "1080p · 2.00 MB/s · 20 ms");
  });
});
