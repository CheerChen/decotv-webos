"use strict";

// Unit tests for m3u8AdFilter.js — pure CommonJS, no framework, run with:
//   node test/m3u8AdFilter.test.js
//
// The core invariant under test: for a dynamically-stitched source, the
// filter's output must be identical regardless of where the CDN inserted
// the ad blocks. Two playlists that differ only in ad position should
// produce the same set of content segments (same URLs, same order) —
// that is the whole correctness argument for the proxy approach.
//
// All test playlists are synthetic — no real CDN URLs or captured fixtures
// are committed to the repo.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var filter = require("../m3u8AdFilter.js");

// ── Synthetic playlist builder ────────────────────────────────────────────
// Generates a media playlist with `contentCount` content segments (all under
// the same date-path signature) and an ad block of `adCount` segments (under
// a different date-path signature) inserted at `adInsertIndex`. Mirrors the
// structure of real dynamically-stitched playlists without using real URLs.

function makeStitchedPlaylist(contentCount, adCount, adInsertIndex) {
  var lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4",
               "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0"];
  for (var i = 0; i < contentCount; i++) {
    if (i === adInsertIndex && adCount > 0) {
      lines.push("#EXT-X-DISCONTINUITY");
      for (var a = 0; a < adCount; a++) {
        lines.push("#EXTINF:5.0,");
        lines.push("https://cdn.test/20260811/ad/10097kb/hls/ad" + a + ".ts");
      }
      lines.push("#EXT-X-DISCONTINUITY");
    }
    lines.push("#EXTINF:2.0,");
    lines.push("https://cdn.test/20260115/ep/3190kb/hls/seg" + i + ".ts");
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

// ── Test 1: stitched playlist filtering — ad segments removed, content intact ──

function testPlaylistFiltering() {
  var text = makeStitchedPlaylist(20, 3, 10);
  var base = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
  var out = filter.filterPlaylist(text, base, {
    rewriteUrl: function (u) { return u; }
  });
  var lines = out.split("\n");

  var adSegs = lines.filter(function (l) { return /20260811\/ad/.test(l); });
  var contentSegs = lines.filter(function (l) { return /20260115\/ep/.test(l); });
  var discs = lines.filter(function (l) { return l === "#EXT-X-DISCONTINUITY"; });
  var hasEndlist = lines[lines.length - 1] === "#EXT-X-ENDLIST";
  var hasHeader = lines[0] === "#EXTM3U";

  assert.strictEqual(adSegs.length, 0, "ad segments should be removed");
  assert.strictEqual(contentSegs.length, 20, "all 20 content segments should be preserved");
  assert.ok(discs.length >= 1, "at least one splice discontinuity should remain");
  assert.ok(hasEndlist, "ENDLIST should be preserved");
  assert.ok(hasHeader, "EXTM3U header should be preserved");
  console.log("  PASS: stitched playlist — 0 ad segs, " + contentSegs.length + " content segs, " + discs.length + " disc(s)");
}

// ── Test 2: content-internal discontinuity is preserved ──

function testContentInternalDiscPreserved() {
  var text = [
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
    "#EXT-X-ENDLIST"
  ].join("\n");
  var base = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
  var out = filter.filterPlaylist(text, base, {
    rewriteUrl: function (u) { return u; }
  });
  var lines = out.split("\n");
  var discCount = lines.filter(function (l) { return l === "#EXT-X-DISCONTINUITY"; }).length;
  var adCount = lines.filter(function (l) { return /20260811/.test(l); }).length;
  var contentCount = lines.filter(function (l) { return /20260115/.test(l); }).length;

  // Expect: 1 content-internal disc (b→c) + 1 splice disc (d→e) = 2
  assert.strictEqual(discCount, 2, "should preserve content-internal disc + 1 splice disc");
  assert.strictEqual(adCount, 0, "ad segment should be removed");
  assert.strictEqual(contentCount, 6, "all 6 content segments should remain");
  console.log("  PASS: content-internal disc preserved (2 discs, 0 ads, 6 content)");
}

// ── Test 3: drift invariance — same content, ads at different positions ──
// Two synthetic playlists with identical content segments but ads inserted
// at different positions. The filter output should contain the same content
// segments in the same order — only the discontinuity positions differ.

function testDriftInvariance() {
  function makePlaylist(adInsertIndex) {
    return makeStitchedPlaylist(10, 1, adInsertIndex);
  }

  var base = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
  var rewriteUrl = function (u) { return u; };

  // Version A: ad at position 3
  var outA = filter.filterPlaylist(makePlaylist(3), base, { rewriteUrl: rewriteUrl });
  // Version B: ad at position 7
  var outB = filter.filterPlaylist(makePlaylist(7), base, { rewriteUrl: rewriteUrl });

  var contentA = outA.split("\n").filter(function (l) { return /seg\d+\.ts/.test(l); });
  var contentB = outB.split("\n").filter(function (l) { return /seg\d+\.ts/.test(l); });

  assert.strictEqual(contentA.length, 10, "version A should have 10 content segs");
  assert.strictEqual(contentB.length, 10, "version B should have 10 content segs");
  assert.deepStrictEqual(contentA, contentB, "content segments should be identical regardless of ad position");
  console.log("  PASS: drift invariance — 10 content segs identical across ad positions 3 vs 7");
}

// ── Test 4: removedAdRanges returns correct original-timeline ranges ──

function testRemovedAdRanges() {
  // 20 content segs (2s each = 40s total), 3 ad segs (5s each = 15s) at index 10
  // Ad block starts at 20s (10 segs * 2s), ends at 35s (20s + 15s)
  var text = makeStitchedPlaylist(20, 3, 10);
  var base = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
  var ranges = filter.removedAdRanges(text, base);

  assert.ok(Array.isArray(ranges), "should return an array");
  assert.strictEqual(ranges.length, 1, "should detect exactly one ad range");
  assert.ok(typeof ranges[0].start === "number", "range.start should be a number");
  assert.ok(typeof ranges[0].end === "number", "range.end should be a number");
  assert.ok(ranges[0].end > ranges[0].start, "range.end should be > range.start");
  // Ad starts at 20s (10 * 2.0), ends at 35s (20 + 3 * 5.0)
  assert.ok(Math.abs(ranges[0].start - 20) < 0.1, "range.start should be ~20s, got " + ranges[0].start);
  assert.ok(Math.abs(ranges[0].end - 35) < 0.1, "range.end should be ~35s, got " + ranges[0].end);
  console.log("  PASS: removedAdRanges — " + ranges.length + " range(s): " +
    ranges.map(function (r) { return "[" + r.start.toFixed(1) + "," + r.end.toFixed(1) + "]"; }).join(" "));
}

// ── Test 5: master playlist URL rewriting ──

function testMasterRewriting() {
  var text = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3190000,RESOLUTION=1920x1080",
    "3190kb/hls/index.m3u8?t=12345"
  ].join("\n");
  var base = "https://cdn.test/20260115/ep/index.m3u8";
  var proxyBase = "http://127.0.0.1:3999/proxy";
  var out = filter.filterPlaylist(text, base, {
    rewriteUrl: function (u, opts) {
      if (opts && opts.kind === "variant") {
        return proxyBase + "?url=" + encodeURIComponent(u);
      }
      return u;
    }
  });
  var lines = out.split("\n");
  var variantLine = lines[lines.length - 1];
  assert.ok(variantLine.indexOf(proxyBase) === 0, "variant URL should point to proxy");
  assert.ok(variantLine.indexOf("url=") !== -1, "variant URL should carry upstream url param");
  console.log("  PASS: master playlist — variant URL rewritten to proxy");
}

// ── Test 6: EXT-X-KEY relative URI is rewritten to absolute ──

function testKeyUriRewriting() {
  var text = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000000',
    "#EXTINF:2.0,",
    "https://cdn.test/20260115/ep/3190kb/hls/seg0.ts",
    "#EXTINF:2.0,",
    "https://cdn.test/20260115/ep/3190kb/hls/seg1.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  var base = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
  var out = filter.filterPlaylist(text, base, {
    rewriteUrl: function (u) { return u; }
  });
  var keyLine = out.split("\n").filter(function (l) { return l.indexOf("#EXT-X-KEY") === 0; })[0];
  assert.ok(keyLine, "EXT-X-KEY line should be present");
  assert.ok(keyLine.indexOf('URI="https://cdn.test/20260115/ep/3190kb/hls/enc.key"') !== -1,
    'relative URI should be rewritten to absolute, got: ' + keyLine);
  console.log("  PASS: EXT-X-KEY relative URI rewritten to absolute");
}

// ── Test 7: the two filter copies are byte-identical ──
// m3u8AdFilter.js exists twice: here (sidecar, debug/control group) and in
// service/com.cheerchen.decotv.service/ (production, on-device proxy). They
// are plain copies — this test fails loudly when someone edits one and
// forgets the other.

function testCopiesInSync() {
  var sidecarCopy = fs.readFileSync(path.join(__dirname, "..", "m3u8AdFilter.js"), "utf8");
  var serviceCopy = fs.readFileSync(path.join(
    __dirname, "..", "..", "service", "com.cheerchen.decotv.service", "m3u8AdFilter.js"
  ), "utf8");
  assert.strictEqual(sidecarCopy, serviceCopy,
    "sidecar and service copies of m3u8AdFilter.js must be byte-identical");
  console.log("  PASS: sidecar and service filter copies are in sync");
}

// ── Runner ──

var tests = [
  ["playlist filtering", testPlaylistFiltering],
  ["content-internal disc preserved", testContentInternalDiscPreserved],
  ["drift invariance", testDriftInvariance],
  ["removedAdRanges", testRemovedAdRanges],
  ["master playlist rewriting", testMasterRewriting],
  ["EXT-X-KEY URI rewriting", testKeyUriRewriting],
  ["filter copies in sync", testCopiesInSync],
];

var passed = 0;
var failed = 0;
tests.forEach(function (entry) {
  var name = entry[0];
  var fn = entry[1];
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.log("  FAIL: " + name + " — " + (e.message || e));
  }
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
