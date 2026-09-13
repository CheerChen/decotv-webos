// tests/m3u8AdFilter.test.js — the service copy of the playlist filter.
//
// This was the sidecar's test file. It moved here when the sidecar stopped
// carrying a filter copy: the filter lives in the on-device service, so its
// tests belong next to the rest of the suite. The old file also asserted the
// two copies were byte-identical; there is only one copy now, and that
// assertion is gone with it.
//
// The core invariant under test: for a dynamically-stitched source, the
// filter's output must be identical regardless of where the CDN inserted the
// ad blocks. Two playlists that differ only in ad position should produce the
// same set of content segments (same URLs, same order) — that is the whole
// correctness argument for the proxy approach.
//
// All test playlists are synthetic — no real CDN URLs or captured fixtures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const filter = require("../service/com.cheerchen.decotv.service/m3u8AdFilter.js");

const BASE = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
const identity = (u) => u;

// Generates a media playlist with `contentCount` content segments (all under
// the same date-path signature) and an ad block of `adCount` segments (under
// a different date-path signature) inserted at `adInsertIndex`. Mirrors the
// structure of real dynamically-stitched playlists without using real URLs.
function makeStitchedPlaylist(contentCount, adCount, adInsertIndex) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (let i = 0; i < contentCount; i++) {
    if (i === adInsertIndex && adCount > 0) {
      lines.push("#EXT-X-DISCONTINUITY");
      for (let a = 0; a < adCount; a++) {
        lines.push("#EXTINF:5.0,");
        lines.push(`https://cdn.test/20260811/ad/10097kb/hls/ad${a}.ts`);
      }
      lines.push("#EXT-X-DISCONTINUITY");
    }
    lines.push("#EXTINF:2.0,");
    lines.push(`https://cdn.test/20260115/ep/3190kb/hls/seg${i}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

describe("m3u8AdFilter (service copy)", () => {
  it("strips ad segments and keeps every content segment", () => {
    const out = filter.filterPlaylist(makeStitchedPlaylist(20, 3, 10), BASE, {
      rewriteUrl: identity,
    });
    const lines = out.split("\n");
    assert.equal(lines.filter((l) => /20260811\/ad/.test(l)).length, 0);
    assert.equal(lines.filter((l) => /20260115\/ep/.test(l)).length, 20);
    assert.ok(lines.filter((l) => l === "#EXT-X-DISCONTINUITY").length >= 1);
    assert.equal(lines[lines.length - 1], "#EXT-X-ENDLIST");
    assert.equal(lines[0], "#EXTM3U");
  });

  it("preserves a content-internal discontinuity and emits one splice disc", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:4",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/a.ts",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/b.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/c.ts",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/d.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.test/20260811/ad/10097kb/hls/ad1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/e.ts",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/f.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const lines = filter.filterPlaylist(text, BASE, { rewriteUrl: identity }).split("\n");
    // 1 content-internal disc (b→c) + 1 splice disc (d→e)
    assert.equal(lines.filter((l) => l === "#EXT-X-DISCONTINUITY").length, 2);
    assert.equal(lines.filter((l) => /20260811/.test(l)).length, 0);
    assert.equal(lines.filter((l) => /20260115/.test(l)).length, 6);
  });

  it("is drift-invariant: the same content survives ads at any position", () => {
    const contentOf = (adInsertIndex) => filter
      .filterPlaylist(makeStitchedPlaylist(10, 1, adInsertIndex), BASE, { rewriteUrl: identity })
      .split("\n")
      .filter((l) => /seg\d+\.ts/.test(l));
    const atThree = contentOf(3);
    const atSeven = contentOf(7);
    assert.equal(atThree.length, 10);
    assert.equal(atSeven.length, 10);
    assert.deepEqual(atThree, atSeven);
  });

  it("reports removed ad ranges on the original timeline", () => {
    // 20 content segs (2s each = 40s), 3 ad segs (5s each = 15s) at index 10:
    // the ad block runs 20s → 35s.
    const ranges = filter.removedAdRanges(makeStitchedPlaylist(20, 3, 10), BASE);
    assert.ok(Array.isArray(ranges));
    assert.equal(ranges.length, 1);
    assert.ok(Math.abs(ranges[0].start - 20) < 0.1, `start ~20s, got ${ranges[0].start}`);
    assert.ok(Math.abs(ranges[0].end - 35) < 0.1, `end ~35s, got ${ranges[0].end}`);
  });

  it("rewrites a master playlist's variant URL", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3190000,RESOLUTION=1920x1080",
      "3190kb/hls/index.m3u8?t=12345",
    ].join("\n");
    const proxyBase = "http://127.0.0.1:3999/proxy";
    const lines = filter.filterPlaylist(text, "https://cdn.test/20260115/ep/index.m3u8", {
      rewriteUrl: (u, opts) => (opts && opts.kind === "variant"
        ? `${proxyBase}?url=${encodeURIComponent(u)}`
        : u),
    }).split("\n");
    const variantLine = lines[lines.length - 1];
    assert.ok(variantLine.startsWith(proxyBase));
    assert.ok(variantLine.includes("url="));
  });

  it("rewrites a relative EXT-X-KEY URI to an absolute one", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:4",
      '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000000',
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/seg0.ts",
      "#EXTINF:2.0,",
      "https://cdn.test/20260115/ep/3190kb/hls/seg1.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const keyLine = filter
      .filterPlaylist(text, BASE, { rewriteUrl: identity })
      .split("\n")
      .find((l) => l.startsWith("#EXT-X-KEY"));
    assert.ok(keyLine, "EXT-X-KEY line should be present");
    assert.ok(
      keyLine.includes('URI="https://cdn.test/20260115/ep/3190kb/hls/enc.key"'),
      `relative URI should be absolute, got: ${keyLine}`
    );
  });
});
