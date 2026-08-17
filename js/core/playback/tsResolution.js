// tsResolution.js — read H.264 coded width/height from an MPEG-TS buffer.
// Used by the ad pre-scan so we do not need ffprobe or a full video decode on
// webOS. Only SPS (NAL type 7) is parsed; HEVC is ignored (returns null).

function expGolomb(reader) {
  let zeros = 0;
  while (reader.readBit() === 0) {
    zeros += 1;
    if (zeros > 32) throw new Error("exp-golomb overflow");
  }
  let value = (1 << zeros) - 1;
  if (zeros > 0) value += reader.readBits(zeros);
  return value;
}

function signedExpGolomb(reader) {
  const v = expGolomb(reader);
  return (v & 1) === 0 ? -(v >> 1) : (v + 1) >> 1;
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bitPos = 0;
  }

  readBit() {
    const byteIndex = this.bitPos >> 3;
    if (byteIndex >= this.bytes.length) throw new Error("bit underrun");
    const bit = (this.bytes[byteIndex] >> (7 - (this.bitPos & 7))) & 1;
    this.bitPos += 1;
    return bit;
  }

  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }
}

// Remove emulation prevention bytes (0x00 0x00 0x03 0xXX → 0x00 0x00 0xXX).
function rbspFromNal(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
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
  const rbsp = rbspFromNal(spsNal.subarray(1));
  const r = new BitReader(rbsp);
  const profileIdc = r.readBits(8);
  r.readBits(8); // constraint flags
  const levelIdc = r.readBits(8);
  expGolomb(r); // seq_parameter_set_id

  let chromaFormatIdc = 1;
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
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (!r.readBit()) continue;
        const lastScale = 8;
        let nextScale = 8;
        const size = i < 6 ? 16 : 64;
        let last = lastScale;
        for (let j = 0; j < size; j++) {
          if (nextScale !== 0) {
            const delta = signedExpGolomb(r);
            nextScale = (last + delta + 256) % 256;
          }
          last = nextScale === 0 ? last : nextScale;
        }
      }
    }
  }

  expGolomb(r); // log2_max_frame_num_minus4
  const picOrderCntType = expGolomb(r);
  if (picOrderCntType === 0) {
    expGolomb(r);
  } else if (picOrderCntType === 1) {
    r.readBit();
    signedExpGolomb(r);
    signedExpGolomb(r);
    const n = expGolomb(r);
    for (let i = 0; i < n; i++) signedExpGolomb(r);
  }
  expGolomb(r); // max_num_ref_frames
  r.readBit(); // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbsMinus1 = expGolomb(r);
  const picHeightInMapUnitsMinus1 = expGolomb(r);
  const frameMbsOnlyFlag = r.readBit();
  if (!frameMbsOnlyFlag) r.readBit();
  r.readBit(); // direct_8x8_inference_flag

  let frameCropLeft = 0;
  let frameCropRight = 0;
  let frameCropTop = 0;
  let frameCropBottom = 0;
  if (r.readBit()) {
    frameCropLeft = expGolomb(r);
    frameCropRight = expGolomb(r);
    frameCropTop = expGolomb(r);
    frameCropBottom = expGolomb(r);
  }

  const width = (picWidthInMbsMinus1 + 1) * 16
    - (frameCropLeft + frameCropRight) * 2;
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16
    - (frameCropTop + frameCropBottom) * 2 * (2 - frameMbsOnlyFlag);

  if (width < 16 || height < 16 || width > 7680 || height > 4320) return null;
  return { w: width, h: height, level: levelIdc };
}

function findNalUnits(payload) {
  const nals = [];
  let i = 0;
  const data = payload;
  while (i + 4 < data.length) {
    let start = -1;
    let sc = 0;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      start = i + 4;
      sc = 4;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      start = i + 3;
      sc = 3;
    }
    if (start < 0) {
      i += 1;
      continue;
    }
    let end = start;
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
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunks = [];
  for (let offset = 0; offset + 188 <= data.length; offset += 188) {
    if (data[offset] !== 0x47) continue;
    const pid = ((data[offset + 1] & 0x1f) << 8) | data[offset + 2];
    // Skip null / PAT / PMT-ish; still try every packet with payload.
    if (pid === 0x1fff) continue;
    const adaptation = (data[offset + 3] >> 4) & 0x3;
    let payloadStart = offset + 4;
    if (adaptation === 2) continue; // adaptation only
    if (adaptation === 3) {
      const len = data[offset + 4];
      payloadStart = offset + 5 + len;
    }
    if (payloadStart >= offset + 188) continue;
    const pusi = (data[offset + 1] & 0x40) !== 0;
    let payload = data.subarray(payloadStart, offset + 188);
    if (pusi && payload.length >= 9 && payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
      // PES header
      const headerLen = payload[8];
      const pesPayloadStart = 9 + headerLen;
      if (pesPayloadStart < payload.length) {
        payload = payload.subarray(pesPayloadStart);
      } else {
        continue;
      }
    }
    if (payload.length) chunks.push(payload);
  }
  if (!chunks.length) return data; // maybe already Annex-B
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer MPEG-TS (or Annex-B) bytes
 * @returns {{ w: number, h: number, level: number } | null}
 */
export function resolutionFromTsBuffer(buffer) {
  try {
    const annexB = annexBFromTs(buffer);
    const nals = findNalUnits(annexB);
    for (const nal of nals) {
      if (!nal.length) continue;
      const nalType = nal[0] & 0x1f;
      if (nalType !== 7) continue; // SPS
      const dims = parseSpsDimensions(nal);
      if (dims) return dims;
    }
  } catch (_) {
    return null;
  }
  return null;
}
