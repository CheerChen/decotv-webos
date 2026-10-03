// tests/tsResolutionParity.test.js — the client (ESM) and service (CJS)
// copies of the SPS parser must agree on every buffer.
//
// The service copy exists so the on-device proxy can classify discontinuity
// groups by coded signature at request time. Two implementations of the same
// parser is a drift risk, so this test feeds both the same synthetic buffers
// and fails on any disagreement — the same pattern the repo uses to keep the
// two m3u8AdFilter copies in sync.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolutionFromTsBuffer as clientParse } from "../js/core/playback/tsResolution.js";
import { tsWithSps, annexBWithSps, tsPackets, spsNal } from "./helpers/syntheticTs.js";

const require = createRequire(import.meta.url);
const { resolutionFromTsBuffer: serviceParse } = require(
  "../service/com.cheerchen.decotv.service/tsResolution.js"
);

// Dimensions seen across the real source families: content, injected ads at a
// different resolution, cropped "2.35:1" rips, and the same-directory same-resolution
// family that is only separable by level_idc.
const CASES = [
  { w: 1920, h: 1080, level: 40 },
  { w: 1920, h: 1080, level: 50 },
  { w: 2542, h: 1080, level: 40 },
  { w: 1920, h: 804, level: 40 },
  { w: 1280, h: 720, level: 31 },
  { w: 848, h: 640, level: 31 },
  { w: 640, h: 360, level: 30 },
  { w: 3840, h: 2160, level: 51 },
  { w: 16, h: 16, level: 10 },
];

describe("tsResolution: client/service parity", () => {
  for (const c of CASES) {
    it(`agrees on ${c.w}x${c.h}@${c.level} and reads it correctly`, () => {
      const buf = tsWithSps(c);
      const fromClient = clientParse(buf);
      const fromService = serviceParse(buf);
      assert.deepEqual(fromService, fromClient);
      assert.deepEqual(fromClient, { w: c.w, h: c.h, level: c.level });
    });
  }

  it("agrees on Annex-B input with no TS framing", () => {
    const buf = annexBWithSps({ w: 1920, h: 1080, level: 40 });
    assert.deepEqual(serviceParse(buf), clientParse(buf));
    assert.deepEqual(clientParse(buf), { w: 1920, h: 1080, level: 40 });
  });

  it("agrees when the SPS sits behind other packets", () => {
    // A PAT-ish packet ahead of the video payload, as in a real segment head.
    const prefix = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const buf = tsWithSps({ w: 1280, h: 720, level: 31, prefix });
    assert.deepEqual(serviceParse(buf), clientParse(buf));
    assert.deepEqual(clientParse(buf), { w: 1280, h: 720, level: 31 });
  });

  it("agrees on an SPS that carries emulation prevention bytes", () => {
    // 3840x2160 crops nothing but the exp-Golomb fields still produce
    // 00 00 sequences, which is where the 0x03 insertion path is exercised.
    const buf = annexBWithSps({ w: 3840, h: 2160, level: 51 });
    assert.ok(spsNal({ w: 3840, h: 2160, level: 51 }).length > 8);
    assert.deepEqual(serviceParse(buf), clientParse(buf));
    assert.deepEqual(clientParse(buf), { w: 3840, h: 2160, level: 51 });
  });

  it("agrees on every degenerate input", () => {
    const inputs = [
      new Uint8Array(0),
      new Uint8Array(1),
      new Uint8Array(187).fill(0x47),
      new Uint8Array(376).fill(0x00),
      Uint8Array.from([0x47, 0x01, 0x00, 0x10]),
      tsPackets(Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x67])), // SPS header only
      tsWithSps({ w: 1920, h: 1080, level: 40, packets: 1 }).subarray(0, 100),
    ];
    for (const input of inputs) {
      assert.deepEqual(serviceParse(input), clientParse(input));
    }
    assert.equal(clientParse(new Uint8Array(0)), null);
  });

  it("agrees that an HEVC-style NAL carries no H.264 SPS", () => {
    // nal_unit_type 33 (HEVC SPS) — the parser must not claim to read it.
    const nal = Uint8Array.from([0x42, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const buf = tsPackets(nal);
    assert.deepEqual(serviceParse(buf), clientParse(buf));
    assert.equal(clientParse(buf), null);
  });
});
