// tests/tsResolution.test.js — SPS dimension parsing smoke checks.
// Run: node --test tests/tsResolution.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolutionFromTsBuffer } from "../js/core/playback/tsResolution.js";

describe("resolutionFromTsBuffer", () => {
  it("returns null on empty input", () => {
    assert.equal(resolutionFromTsBuffer(new Uint8Array(0)), null);
  });

  // Optional: if Mac probe files from the ad investigation are still around,
  // validate real segments. Skip silently when absent so CI stays green.
  const content = "/tmp/adprobe/segs/t0490_g25_04.ts";
  const ad = "/tmp/adprobe/segs/t0500_g27_09.ts";

  it("reads 1920x1080 from a known content segment when present", () => {
    if (!existsSync(content)) return;
    const dims = resolutionFromTsBuffer(readFileSync(content));
    assert.ok(dims);
    assert.equal(dims.w, 1920);
    assert.equal(dims.h, 1080);
    assert.ok(Number.isInteger(dims.level) && dims.level > 0);
  });

  it("reads 848x640 from a known ad segment when present", () => {
    if (!existsSync(ad)) return;
    const dims = resolutionFromTsBuffer(readFileSync(ad));
    assert.ok(dims);
    assert.equal(dims.w, 848);
    assert.equal(dims.h, 640);
    assert.ok(Number.isInteger(dims.level) && dims.level > 0);
  });

  // dytt mixed.m3u8 case: ad re-encoded to the same 1920x1080 as content —
  // only level_idc separates them (ad @50, content @40).
  const dyttAd = "/tmp/dytt_ad.ts";
  const dyttContent = "/tmp/dytt_content.ts";

  it("distinguishes same-resolution dytt ad via level_idc when present", () => {
    if (!existsSync(dyttAd) || !existsSync(dyttContent)) return;
    const adDims = resolutionFromTsBuffer(readFileSync(dyttAd));
    const ctDims = resolutionFromTsBuffer(readFileSync(dyttContent));
    assert.ok(adDims && ctDims);
    assert.equal(adDims.w, ctDims.w);
    assert.equal(adDims.h, ctDims.h);
    assert.notEqual(adDims.level, ctDims.level);
  });
});
