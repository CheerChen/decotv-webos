"use strict";

// Unit tests for m3u8AdFilter.js — pure CommonJS, no framework, run with:
//   node test/m3u8AdFilter.test.js
//
// The core invariant under test: for a dynamically-stitched source, the
// filter's output must be identical regardless of where the CDN inserted
// the ad blocks. Two playlists that differ only in ad position should
// produce the same set of content segments (same URLs, same order) —
// that is the whole correctness argument for the proxy approach.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var filter = require("../m3u8AdFilter.js");

var FIXTURE_DIR = path.join(__dirname);
function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

// ── Test 1: real bfikuncdn playlist — ad segments removed, content intact ──

function testRealPlaylistFiltering() {
  var text = loadFixture("fixture_bfikuncdn_variant.m3u8");
  var base = "https://bfikuncdn.com/20260115/mocDe1mI/3190kb/hls/index.m3u8";
  var out = filter.filterPlaylist(text, base, {
    rewriteUrl: function (u) { return u; }
  });
  var lines = out.split("\n");

  var adSegs = lines.filter(function (l) { return /20260811\/lGevlkDG/.test(l); });
  var contentSegs = lines.filter(function (l) { return /20260115\/mocDe1mI/.test(l); });
  var discs = lines.filter(function (l) { return l === "#EXT-X-DISCONTINUITY"; });
  var hasEndlist = lines[lines.length - 1] === "#EXT-X-ENDLIST";
  var hasHeader = lines[0] === "#EXTM3U";

  assert.strictEqual(adSegs.length, 0, "ad segments should be removed");
  assert.ok(contentSegs.length > 700, "content segments should be preserved (got " + contentSegs.length + ")");
  assert.ok(discs.length >= 1, "at least one splice discontinuity should remain");
  assert.ok(hasEndlist, "ENDLIST should be preserved");
  assert.ok(hasHeader, "EXTM3U header should be preserved");
  console.log("  PASS: real bfikuncdn playlist — 0 ad segs, " + contentSegs.length + " content segs, " + discs.length + " disc(s)");
}

// ── Test 2: content-internal discontinuity is preserved ──

function testContentInternalDiscPreserved() {
  var text = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXTINF:2.0,",
    "https://cdn.example/20260115/ep/3190kb/hls/a.ts",
    "#EXTINF:2.0,",
    "https://cdn.example/20260115/ep/3190kb/hls/b.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:2.0,",
    "https://cdn.example/20260115/ep/3190kb/hls/c.ts",
    "#EXTINF:2.0,",
    "https://cdn.example/20260115/ep/3190kb/hls/d.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:2.0,",
    "https://cdn.example/20260811/ad/10097kb/hls/ad1.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:2.0,",
    "https://cdn.example/20260115/ep/3190kb/hls/e.ts",
    "#EXTINF:2.0,",
    "https://cdn.example/20260115/ep/3190kb/hls/f.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  var base = "https://cdn.example/20260115/ep/3190kb/hls/index.m3u8";
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
    var segs = [];
    for (var i = 0; i < 10; i++) {
      segs.push({
        extinf: "#EXTINF:2.0,",
        url: "https://cdn.example/20260115/ep/3190kb/hls/seg" + i + ".ts"
      });
    }
    var ad = {
      extinf: "#EXTINF:5.0,",
      url: "https://cdn.example/20260811/ad/10097kb/hls/ad1.ts"
    };
    // Insert ad at adInsertIndex
    var withAd = segs.slice(0, adInsertIndex).concat([ad]).concat(segs.slice(adInsertIndex));

    var lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:5"];
    for (var j = 0; j < withAd.length; j++) {
      if (j > 0 && (j === adInsertIndex || j === adInsertIndex + 1)) {
        lines.push("#EXT-X-DISCONTINUITY");
      }
      lines.push(withAd[j].extinf);
      lines.push(withAd[j].url);
    }
    lines.push("#EXT-X-ENDLIST");
    return lines.join("\n");
  }

  var base = "https://cdn.example/20260115/ep/3190kb/hls/index.m3u8";
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
  var text = loadFixture("fixture_bfikuncdn_variant.m3u8");
  var base = "https://bfikuncdn.com/20260115/mocDe1mI/3190kb/hls/index.m3u8";
  var ranges = filter.removedAdRanges(text, base);

  assert.ok(Array.isArray(ranges), "should return an array");
  assert.ok(ranges.length > 0, "should detect at least one ad range");
  for (var i = 0; i < ranges.length; i++) {
    assert.ok(typeof ranges[i].start === "number", "range.start should be a number");
    assert.ok(typeof ranges[i].end === "number", "range.end should be a number");
    assert.ok(ranges[i].end > ranges[i].start, "range.end should be > range.start");
  }
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
  var base = "https://bfikuncdn.com/20260115/mocDe1mI/index.m3u8";
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

// ── Test 6: the two filter copies are byte-identical ──
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
  ["real playlist filtering", testRealPlaylistFiltering],
  ["content-internal disc preserved", testContentInternalDiscPreserved],
  ["drift invariance", testDriftInvariance],
  ["removedAdRanges", testRemovedAdRanges],
  ["master playlist rewriting", testMasterRewriting],
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
