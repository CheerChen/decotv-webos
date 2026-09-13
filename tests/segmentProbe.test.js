// tests/segmentProbe.test.js — request-time coded-signature classification.
//
// Covers the same-directory ad family (identical URL signature, separable
// only by coded signature), AES-128 encrypted sources, the noise floor, the
// budget, both caches, and the end-to-end verdict → playlist deletion path.
// Network access is injected, so no CDN is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { tsWithSps } from "./helpers/syntheticTs.js";

const require = createRequire(import.meta.url);
const { createSegmentProber, needsProbe, MIN_AD_RANGE_S } = require(
  "../service/com.cheerchen.decotv.service/segmentProbe.js"
);
const aes128 = require("../service/com.cheerchen.decotv.service/aes128.js");
const filter = require("../service/com.cheerchen.decotv.service/m3u8AdFilter.js");

const BASE = "https://cdn.test/20260115/ep/3190kb/hls/index.m3u8";
const KEY_URL = "https://cdn.test/20260115/ep/3190kb/hls/enc.key";
const KEY_BYTES = Buffer.from("0123456789abcdef");

// ── Playlist builder ──────────────────────────────────────────────────────

function buildPlaylist(blocks) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  blocks.forEach((block, index) => {
    if (index > 0) lines.push("#EXT-X-DISCONTINUITY");
    if (block.key) lines.push(block.key);
    for (const seg of block.segments) {
      lines.push(`#EXTINF:${seg.dur},`);
      lines.push(seg.url);
    }
  });
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

function group(name, count, { dur = 6, dir = "3190kb" } = {}) {
  return {
    segments: Array.from({ length: count }, (_, i) => ({
      dur,
      url: `https://cdn.test/20260115/ep/${dir}/${name}${i}.ts`,
    })),
  };
}

// Same directory, same resolution: the dytt mixed.m3u8 family. Only the
// coded signature (level_idc) separates the ad block from the episode.
function sameDirPlaylist({ adLevel = 50, contentLevel = 40, adCount = 5, adDur = 6 } = {}) {
  const text = buildPlaylist([
    group("c", 4),
    group("a", adCount, { dur: adDur }),
    group("c", 4),
  ]);
  return { text, adLevel, contentLevel, adCount, adDur };
}

function fakeFetch(files, { onFetch = null } = {}) {
  return (url, maxBytes, cb) => {
    if (onFetch) onFetch(url);
    const entry = files[url];
    if (entry === undefined) {
      cb(new Error("404 " + url));
      return;
    }
    const buf = Buffer.isBuffer(entry) ? entry : Buffer.from(entry);
    cb(null, buf.subarray(0, maxBytes));
  };
}

function encryptSegment(plain, key, iv) {
  const pad = (16 - (plain.length % 16)) % 16;
  const padded = Buffer.concat([Buffer.from(plain), Buffer.alloc(pad, 0xff)]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function classify(text, files, opts = {}) {
  const prober = createSegmentProber({
    fetchBytes: fakeFetch(files, opts),
    ...(opts.prober || {}),
  });
  const analysis = filter.analyzeGroups(text, BASE);
  return new Promise((resolve, reject) => {
    prober.classify(analysis, (err, verdict) => {
      if (err) reject(err);
      else resolve({ verdict, analysis, prober });
    });
  });
}

// Every group's first segment is served with the resolution it should have.
function contentFiles(blocks) {
  const files = {};
  blocks.forEach((block) => {
    files[block.segments[0].url] = tsWithSps(block.dims);
  });
  return files;
}

// ── AES-128 ───────────────────────────────────────────────────────────────

describe("aes128", () => {
  it("decrypts a window and drops the partial trailing block", () => {
    const plain = Buffer.alloc(64, 0x41);
    const iv = Buffer.alloc(16, 0x02);
    const cipher = crypto.createCipheriv("aes-128-cbc", KEY_BYTES, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const window = encrypted.subarray(0, 50); // not a block multiple
    const out = aes128.decryptCbcWindow(window, KEY_BYTES, iv);
    assert.equal(out.length, 48);
    assert.deepEqual(out, plain.subarray(0, 48));
  });

  it("derives the default IV from the media sequence number", () => {
    assert.deepEqual(aes128.ivFromSequence(0), Buffer.alloc(16));
    assert.deepEqual(aes128.ivFromSequence(7), Buffer.from("00000000000000000000000000000007", "hex"));
    assert.deepEqual(
      aes128.ivFromSequence(0x0001020304050607),
      Buffer.from("00000000000000000001020304050607", "hex")
    );
    // Above 2^32 the high half must land in bytes 8..11, not bytes 4..7.
    assert.deepEqual(
      aes128.ivFromSequence(4294967296 + 7),
      Buffer.from("00000000000000000000000100000007", "hex")
    );
  });

  it("prefers an explicit IV over the sequence number", () => {
    const iv = aes128.resolveIv({ ivHex: "0f".repeat(16) }, 99);
    assert.deepEqual(iv, Buffer.alloc(16, 0x0f));
  });

  it("refuses an unusable key or IV instead of throwing", () => {
    const iv = Buffer.alloc(16);
    assert.equal(aes128.decryptCbcWindow(Buffer.alloc(32), Buffer.alloc(8), iv), null);
    assert.equal(aes128.decryptCbcWindow(Buffer.alloc(32), KEY_BYTES, null), null);
    assert.equal(aes128.decryptCbcWindow(Buffer.alloc(8), KEY_BYTES, iv), null);
    assert.equal(aes128.decryptCbcWindow(null, KEY_BYTES, iv), null);
    assert.equal(aes128.ivFromHex("aabb"), null);
  });
});

// ── Probe trigger ─────────────────────────────────────────────────────────

describe("needsProbe", () => {
  const analyze = (text) => filter.analyzeGroups(text, BASE);

  it("skips a single-group playlist", () => {
    assert.equal(needsProbe(analyze(buildPlaylist([group("c", 5)]))), false);
  });

  it("probes the same-directory family, which has a perfect majority signature", () => {
    // Every group shares one directory, so the signature rule is blind —
    // this is the case the probe exists for, and a majority-based trigger
    // would have skipped it.
    const text = buildPlaylist([group("c", 4), group("a", 5), group("c2", 4)]);
    const analysis = analyze(text);
    assert.equal(analysis.baselineSig, "https://cdn.test/20260115/ep/3190kb/");
    assert.equal(needsProbe(analysis), true);
  });

  it("skips a playlist the signature rule can already act on", () => {
    const text = buildPlaylist([
      group("c", 4),
      { segments: Array.from({ length: 3 }, (_, i) => ({
        dur: 6,
        url: `https://cdn.test/20260811/ad/10097kb/hls/ad${i}.ts`,
      })) },
      group("c2", 4),
    ]);
    assert.equal(needsProbe(analyze(text)), false);
  });

  it("probes a playlist with no usable majority signature", () => {
    // Rotating hosts group-by-group: no signature owns more than half.
    const text = buildPlaylist([
      { segments: [{ dur: 6, url: "https://a.test/d1/s0.ts" }] },
      { segments: [{ dur: 6, url: "https://b.test/d2/s0.ts" }] },
      { segments: [{ dur: 6, url: "https://c.test/d3/s0.ts" }] },
    ]);
    const analysis = analyze(text);
    assert.equal(analysis.baselineSig, null);
    assert.equal(needsProbe(analysis), true);
  });
});

// ── Classification ────────────────────────────────────────────────────────

describe("segmentProbe classification", () => {
  it("flags a same-directory ad block via level_idc alone", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const { verdict } = await classify(buildPlaylist(blocks), contentFiles(blocks));
    assert.deepEqual(verdict.adGroupIndices, [1]);
    assert.deepEqual(verdict.baseline, { w: 1920, h: 1080, level: 40 });
    assert.equal(verdict.failed, 0);
    assert.equal(verdict.probed, 3);
  });

  it("flags an ad block encoded at a different resolution", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 848, h: 640, level: 31 }, ...group("a", 4) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const { verdict } = await classify(buildPlaylist(blocks), contentFiles(blocks));
    assert.deepEqual(verdict.adGroupIndices, [1]);
  });

  it("flags two adjacent ad groups as one block", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 3) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a2", 3) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const { verdict } = await classify(buildPlaylist(blocks), contentFiles(blocks));
    assert.deepEqual(verdict.adGroupIndices, [1, 2]);
  });

  it("leaves a deviating run under the noise floor alone", async () => {
    // A single 2s anomaly is encoder noise, not an ad block — deleting it
    // would cut content.
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 1, { dur: 2 }) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const { verdict } = await classify(buildPlaylist(blocks), contentFiles(blocks));
    assert.deepEqual(verdict.adGroupIndices, []);
    assert.ok(MIN_AD_RANGE_S > 2);
  });

  it("never flags a group it could not probe", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const files = contentFiles(blocks);
    delete files[blocks[1].segments[0].url]; // ad segment 404s
    const { verdict } = await classify(buildPlaylist(blocks), files);
    assert.deepEqual(verdict.adGroupIndices, []);
    assert.equal(verdict.failed, 1);
  });

  it("under-flags rather than over-flags when the budget runs out", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    // A clock that jumps past the deadline on the first check.
    let t = 0;
    const { verdict } = await classify(buildPlaylist(blocks), contentFiles(blocks), {
      prober: { now: () => (t += 100000), budgetMs: 1000, concurrency: 1 },
    });
    assert.equal(verdict.budgetExceeded, true);
    assert.deepEqual(verdict.adGroupIndices, []);
  });

  it("returns nothing when no group is readable", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
    ];
    const { verdict } = await classify(buildPlaylist(blocks), {});
    assert.deepEqual(verdict.adGroupIndices, []);
    assert.equal(verdict.baseline, null);
    assert.equal(verdict.failed, 2);
  });
});

// ── Encrypted sources ─────────────────────────────────────────────────────

describe("segmentProbe with AES-128 sources", () => {
  const keyTag = (iv) =>
    `#EXT-X-KEY:METHOD=AES-128,URI="enc.key"${iv ? `,IV=0x${iv}` : ""}`;

  it("classifies an encrypted playlist with an explicit IV", async () => {
    const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, key: keyTag(iv.toString("hex")), ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const files = {
      [KEY_URL]: KEY_BYTES,
      ...Object.fromEntries(
        blocks.map((b) => [b.segments[0].url, encryptSegment(tsWithSps(b.dims), KEY_BYTES, iv)])
      ),
    };
    const { verdict } = await classify(buildPlaylist(blocks), files);
    assert.equal(verdict.encrypted, true);
    assert.deepEqual(verdict.adGroupIndices, [1]);
  });

  it("classifies an encrypted playlist whose IV comes from the media sequence", async () => {
    // No IV in the key tag: HLS falls back to the segment's media sequence
    // number, so each group's first segment has its own IV.
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, key: keyTag(null), ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const files = {
      [KEY_URL]: KEY_BYTES,
      ...Object.fromEntries(
        blocks.map((b, index) => {
          const seq = blocks.slice(0, index).reduce((n, prev) => n + prev.segments.length, 0);
          return [
            b.segments[0].url,
            encryptSegment(tsWithSps(b.dims), KEY_BYTES, aes128.ivFromSequence(seq)),
          ];
        })
      ),
    };
    const { verdict } = await classify(buildPlaylist(blocks), files);
    assert.deepEqual(verdict.adGroupIndices, [1]);
  });

  it("resolves each group's own key when a playlist rotates keys", async () => {
    const keyB = Buffer.from("fedcba9876543210");
    const ivA = Buffer.alloc(16, 7);
    const ivB = Buffer.alloc(16, 9);
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, key: keyTag(ivA.toString("hex")), ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 },
        key: `#EXT-X-KEY:METHOD=AES-128,URI="rot.key",IV=0x${ivB.toString("hex")}"`,
        ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, key: keyTag(ivA.toString("hex")), ...group("c2", 4) },
    ];
    const files = {
      [KEY_URL]: KEY_BYTES,
      "https://cdn.test/20260115/ep/3190kb/hls/rot.key": keyB,
      [blocks[0].segments[0].url]: encryptSegment(tsWithSps(blocks[0].dims), KEY_BYTES, ivA),
      [blocks[1].segments[0].url]: encryptSegment(tsWithSps(blocks[1].dims), keyB, ivB),
      [blocks[2].segments[0].url]: encryptSegment(tsWithSps(blocks[2].dims), KEY_BYTES, ivA),
    };
    const { verdict } = await classify(buildPlaylist(blocks), files);
    assert.deepEqual(verdict.adGroupIndices, [1]);
    assert.equal(verdict.failed, 0);
  });

  it("flags nothing when the key cannot be fetched", async () => {
    const iv = Buffer.alloc(16, 3);
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, key: keyTag(iv.toString("hex")), ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const files = Object.fromEntries(
      blocks.map((b) => [b.segments[0].url, encryptSegment(tsWithSps(b.dims), KEY_BYTES, iv)])
    );
    const { verdict } = await classify(buildPlaylist(blocks), files);
    assert.deepEqual(verdict.adGroupIndices, []);
    assert.equal(verdict.failed, blocks.length);
  });
});

// ── Caches ────────────────────────────────────────────────────────────────

describe("segmentProbe caches", () => {
  it("serves a repeat playlist from the decision cache without refetching", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const text = buildPlaylist(blocks);
    const fetches = [];
    const files = contentFiles(blocks);
    const prober = createSegmentProber({ fetchBytes: fakeFetch(files, { onFetch: (u) => fetches.push(u) }) });
    const analysis = filter.analyzeGroups(text, BASE);

    const first = await new Promise((res) => prober.classify(analysis, (_, v) => res(v)));
    const afterFirst = fetches.length;
    assert.ok(afterFirst >= 3);

    const second = await new Promise((res) => prober.classify(analysis, (_, v) => res(v)));
    assert.equal(fetches.length, afterFirst, "second classify must not refetch");
    assert.equal(second.decisionCached, true);
    assert.deepEqual(second.adGroupIndices, first.adGroupIndices);
  });

  it("re-probes once the segment cache expires", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
    ];
    const fetches = [];
    let clock = 0;
    const prober = createSegmentProber({
      fetchBytes: fakeFetch(contentFiles(blocks), { onFetch: (u) => fetches.push(u) }),
      now: () => clock,
      segmentTtlMs: 1000,
      decisionTtlMs: 1000,
    });
    const analysis = filter.analyzeGroups(buildPlaylist(blocks), BASE);
    await new Promise((res) => prober.classify(analysis, () => res()));
    const afterFirst = fetches.length;
    clock += 5000;
    const verdict = await new Promise((res) => prober.classify(analysis, (_, v) => res(v)));
    assert.equal(verdict.decisionCached, undefined);
    assert.ok(fetches.length > afterFirst, "expired caches must refetch");
  });

  it("prunes expired entries instead of growing without bound", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
    ];
    let clock = 0;
    const prober = createSegmentProber({
      fetchBytes: fakeFetch(contentFiles(blocks)),
      now: () => clock,
      segmentTtlMs: 1000,
      decisionTtlMs: 1000,
    });
    const analysis = filter.analyzeGroups(buildPlaylist(blocks), BASE);
    await new Promise((res) => prober.classify(analysis, () => res()));
    assert.ok(prober.cacheSizes().segments > 0);
    clock += 60_000;
    await new Promise((res) => prober.classify(analysis, () => res()));
    // The stale entries are gone; only the fresh ones remain.
    assert.ok(prober.cacheSizes().segments <= 2);
  });
});

// ── Verdict → playlist deletion ───────────────────────────────────────────

describe("probe verdict drives playlist deletion", () => {
  it("deletes the same-directory ad block the signature rule cannot see", async () => {
    const blocks = [
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c", 4) },
      { dims: { w: 1920, h: 1080, level: 50 }, ...group("a", 5) },
      { dims: { w: 1920, h: 1080, level: 40 }, ...group("c2", 4) },
    ];
    const text = buildPlaylist(blocks);
    const analysis = filter.analyzeGroups(text, BASE);

    // Baseline check: the URL-signature rule alone sees one signature and
    // therefore removes nothing.
    assert.equal(analysis.baselineSig, "https://cdn.test/20260115/ep/3190kb/");
    assert.deepEqual(filter.removedAdRanges(text, BASE), []);
    assert.equal(filter.filterPlaylist(text, BASE), text);

    const { verdict } = await classify(text, contentFiles(blocks));
    assert.deepEqual(verdict.adGroupIndices, [1]);

    const filtered = filter.filterPlaylist(text, BASE, { adGroupIndices: verdict.adGroupIndices });
    assert.ok(!filtered.includes("/a0.ts"), "ad segment must be gone");
    assert.ok(filtered.includes("/c0.ts") && filtered.includes("/c20.ts"), "content must survive");
    assert.equal(filtered.split("#EXT-X-ENDLIST").length - 1, 1);
    assert.ok(filtered.includes("#EXT-X-DISCONTINUITY"), "splice disc must be kept");

    // meta must agree with the rewrite, or the resume mapping drifts.
    const ranges = filter.removedAdRanges(text, BASE, { adGroupIndices: verdict.adGroupIndices });
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 24);
    assert.equal(ranges[0].end, 54);
  });

  it("keeps the signature rule working when no probe ran", () => {
    const text = buildPlaylist([
      group("c", 4),
      { segments: Array.from({ length: 3 }, (_, i) => ({
        dur: 6,
        url: `https://cdn.test/20260811/ad/10097kb/hls/ad${i}.ts`,
      })) },
      group("c2", 4),
    ]);
    const filtered = filter.filterPlaylist(text, BASE);
    assert.ok(!filtered.includes("/ad0.ts"));
    assert.ok(filtered.includes("/c0.ts"));
  });

  it("accepts the verdict as an array or as a keyed object", () => {
    const text = buildPlaylist([group("c", 2), group("a", 2), group("c2", 2)]);
    const asArray = filter.filterPlaylist(text, BASE, { adGroupIndices: [1] });
    const asObject = filter.filterPlaylist(text, BASE, { adGroupIndices: { 1: true } });
    assert.equal(asArray, asObject);
    assert.ok(!asArray.includes("/a0.ts"));
  });
});

// ── Group analysis ────────────────────────────────────────────────────────

describe("analyzeGroups", () => {
  it("carries the first segment's URL, sequence number and key", () => {
    const text = buildPlaylist([
      group("c", 3),
      { key: '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00112233445566778899aabbccddeeff', ...group("a", 2) },
    ]);
    const analysis = filter.analyzeGroups(text, BASE);
    assert.equal(analysis.groups.length, 2);
    assert.equal(analysis.groups[0].firstSeq, 0);
    assert.equal(analysis.groups[1].firstSeq, 3);
    assert.equal(analysis.groups[0].key, null);
    assert.deepEqual(analysis.groups[1].key, {
      method: "AES-128",
      uri: KEY_URL,
      ivHex: "00112233445566778899aabbccddeeff",
    });
    assert.equal(analysis.groups[1].firstUrl, "https://cdn.test/20260115/ep/3190kb/a0.ts");
  });

  it("honours a non-zero media sequence and an absolute key URI", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:120",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k.bin"',
      "#EXTINF:6,",
      "seg0.ts",
    ].join("\n");
    const analysis = filter.analyzeGroups(text, BASE);
    assert.equal(analysis.mediaSequence, 120);
    assert.equal(analysis.groups[0].firstSeq, 120);
    assert.equal(analysis.groups[0].key.uri, "https://keys.test/k.bin");
  });

  it("returns nothing for a master playlist", () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
    const analysis = filter.analyzeGroups(master, BASE);
    assert.deepEqual(analysis.groups, []);
    assert.equal(analysis.baselineSig, null);
  });
});
