"use strict";

// tsResolution.js (service copy) — read H.264 coded width/height from an
// MPEG-TS buffer, CommonJS, old-Node compatible (the webOS service runtime
// has no ESM). Only SPS (NAL type 7) is parsed; HEVC and fMP4 return null.
//
// This is a port of js/core/playback/tsResolution.js. The client copy feeds
// the ad pre-scan; this copy lets the on-device proxy classify discontinuity
// groups by coded signature at request time, so same-directory ad blocks
// (identical URL signature, distinguishable only by resolution/level_idc)
// can be DELETED from the playlist instead of seek-skipped by the player.
//
// The two copies must stay in sync: tests/tsResolutionParity.test.js feeds
// the same synthetic buffers to both and fails on any disagreement.

function expGolomb(reader) {
  var zeros = 0;
  while (reader.readBit() === 0) {
    zeros += 1;
    if (zeros > 32) throw new Error("exp-golomb overflow");
  }
  var value = (1 << zeros) - 1;
  if (zeros > 0) value += reader.readBits(zeros);
  return value;
}

function signedExpGolomb(reader) {
  var v = expGolomb(reader);
  return (v & 1) === 0 ? -(v >> 1) : (v + 1) >> 1;
}

function BitReader(bytes) {
  this.bytes = bytes;
  this.bitPos = 0;
}

BitReader.prototype.readBit = function () {
  var byteIndex = this.bitPos >> 3;
  if (byteIndex >= this.bytes.length) throw new Error("bit underrun");
  var bit = (this.bytes[byteIndex] >> (7 - (this.bitPos & 7))) & 1;
  this.bitPos += 1;
  return bit;
};

BitReader.prototype.readBits = function (n) {
  var v = 0;
  for (var i = 0; i < n; i++) v = (v << 1) | this.readBit();
  return v;
};

// Remove emulation prevention bytes (0x00 0x00 0x03 0xXX → 0x00 0x00 0xXX).
function rbspFromNal(nal) {
  var out = [];
  for (var i = 0; i < nal.length; i++) {
    if (
      i + 2 < nal.length
      && nal[i] === 0x00
      && nal[i + 1] === 0x00
      && nal[i + 2] === 0x03
    ) {
      out.push(0x00, 0x00);
      i += 2;
      continue;
    }
    out.push(nal[i]);
  }
  return new Uint8Array(out);
}

function parseSpsDimensions(spsNal) {
  // spsNal includes the 1-byte NAL header.
  if (spsNal.length < 8) return null;
  var rbsp = rbspFromNal(spsNal.subarray(1));
  var r = new BitReader(rbsp);
  var profileIdc = r.readBits(8);
  r.readBits(8); // constraint flags
  var levelIdc = r.readBits(8);
  expGolomb(r); // seq_parameter_set_id

  var chromaFormatIdc = 1;
  if (
    profileIdc === 100 || profileIdc === 110 || profileIdc === 122
    || profileIdc === 244 || profileIdc === 44 || profileIdc === 83
    || profileIdc === 86 || profileIdc === 118 || profileIdc === 128
    || profileIdc === 138 || profileIdc === 139 || profileIdc === 134
  ) {
    chromaFormatIdc = expGolomb(r);
    if (chromaFormatIdc === 3) r.readBit(); // separate_colour_plane_flag
    expGolomb(r); // bit_depth_luma_minus8
    expGolomb(r); // bit_depth_chroma_minus8
    r.readBit(); // qpprime_y_zero_transform_bypass_flag
    if (r.readBit()) { // seq_scaling_matrix_present_flag
      var count = chromaFormatIdc !== 3 ? 8 : 12;
      for (var i = 0; i < count; i++) {
        if (!r.readBit()) continue;
        var lastScale = 8;
        var nextScale = 8;
        var size = i < 6 ? 16 : 64;
        var last = lastScale;
        for (var j = 0; j < size; j++) {
          if (nextScale !== 0) {
            var delta = signedExpGolomb(r);
            nextScale = (last + delta + 256) % 256;
          }
          last = nextScale === 0 ? last : nextScale;
        }
      }
    }
  }

  expGolomb(r); // log2_max_frame_num_minus4
  var picOrderCntType = expGolomb(r);
  if (picOrderCntType === 0) {
    expGolomb(r);
  } else if (picOrderCntType === 1) {
    r.readBit();
    signedExpGolomb(r);
    signedExpGolomb(r);
    var n = expGolomb(r);
    for (var k = 0; k < n; k++) signedExpGolomb(r);
  }
  expGolomb(r); // max_num_ref_frames
  r.readBit(); // gaps_in_frame_num_value_allowed_flag
  var picWidthInMbsMinus1 = expGolomb(r);
  var picHeightInMapUnitsMinus1 = expGolomb(r);
  var frameMbsOnlyFlag = r.readBit();
  if (!frameMbsOnlyFlag) r.readBit();
  r.readBit(); // direct_8x8_inference_flag

  var frameCropLeft = 0;
  var frameCropRight = 0;
  var frameCropTop = 0;
  var frameCropBottom = 0;
  if (r.readBit()) {
    frameCropLeft = expGolomb(r);
    frameCropRight = expGolomb(r);
    frameCropTop = expGolomb(r);
    frameCropBottom = expGolomb(r);
  }

  var width = (picWidthInMbsMinus1 + 1) * 16
    - (frameCropLeft + frameCropRight) * 2;
  var height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16
    - (frameCropTop + frameCropBottom) * 2 * (2 - frameMbsOnlyFlag);

  if (width < 16 || height < 16 || width > 7680 || height > 4320) return null;
  return { w: width, h: height, level: levelIdc };
}

function findNalUnits(payload) {
  var nals = [];
  var i = 0;
  var data = payload;
  while (i + 4 < data.length) {
    var start = -1;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      start = i + 4;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      start = i + 3;
    }
    if (start < 0) {
      i += 1;
      continue;
    }
    var end = start;
    while (end + 3 < data.length) {
      if (
        data[end] === 0 && data[end + 1] === 0
        && (data[end + 2] === 1 || (data[end + 2] === 0 && data[end + 3] === 1))
      ) break;
      end += 1;
    }
    if (end + 3 >= data.length) end = data.length;
    nals.push(data.subarray(start, end));
    i = start;
  }
  return nals;
}

// Extract Annex-B byte stream from MPEG-TS video PESes (best effort).
function annexBFromTs(buffer) {
  var data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  var chunks = [];
  for (var offset = 0; offset + 188 <= data.length; offset += 188) {
    if (data[offset] !== 0x47) continue;
    var pid = ((data[offset + 1] & 0x1f) << 8) | data[offset + 2];
    // Skip null / PAT / PMT-ish; still try every packet with payload.
    if (pid === 0x1fff) continue;
    var adaptation = (data[offset + 3] >> 4) & 0x3;
    var payloadStart = offset + 4;
    if (adaptation === 2) continue; // adaptation only
    if (adaptation === 3) {
      var len = data[offset + 4];
      payloadStart = offset + 5 + len;
    }
    if (payloadStart >= offset + 188) continue;
    var pusi = (data[offset + 1] & 0x40) !== 0;
    var payload = data.subarray(payloadStart, offset + 188);
    if (pusi && payload.length >= 9 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
      // PES header
      var headerLen = payload[8];
      var pesPayloadStart = 9 + headerLen;
      if (pesPayloadStart < payload.length) {
        payload = payload.subarray(pesPayloadStart);
      } else {
        continue;
      }
    }
    if (payload.length) chunks.push(payload);
  }
  if (!chunks.length) return data; // maybe already Annex-B
  var total = 0;
  for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
  var out = new Uint8Array(total);
  var o = 0;
  for (var m = 0; m < chunks.length; m++) {
    out.set(chunks[m], o);
    o += chunks[m].length;
  }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array|Buffer} buffer MPEG-TS (or Annex-B) bytes
 * @returns {{ w: number, h: number, level: number } | null}
 */
function resolutionFromTsBuffer(buffer) {
  try {
    var annexB = annexBFromTs(buffer);
    var nals = findNalUnits(annexB);
    for (var i = 0; i < nals.length; i++) {
      var nal = nals[i];
      if (!nal.length) continue;
      var nalType = nal[0] & 0x1f;
      if (nalType !== 7) continue; // SPS
      var dims = parseSpsDimensions(nal);
      if (dims) return dims;
    }
  } catch (_) {
    return null;
  }
  return null;
}

module.exports = {
  resolutionFromTsBuffer: resolutionFromTsBuffer
};
