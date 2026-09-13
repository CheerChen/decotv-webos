// tests/helpers/syntheticTs.js — build MPEG-TS / Annex-B buffers carrying a
// synthetic H.264 SPS, so the SPS parser can be exercised without committing
// captured segments. Shared by tests/tsResolutionParity.test.js, which feeds
// the same buffers to the client (ESM) and service (CJS) copies and asserts
// they agree.

// ── Bit writer (MSB first) ────────────────────────────────────────────────

function bitWriter() {
  const out = [];
  let cur = 0;
  let n = 0;
  const push = (bit) => {
    cur = (cur << 1) | (bit & 1);
    n += 1;
    if (n === 8) {
      out.push(cur);
      cur = 0;
      n = 0;
    }
  };
  return {
    bit: push,
    bits(value, count) {
      for (let i = count - 1; i >= 0; i--) push((value >> i) & 1);
    },
    // Unsigned exp-Golomb.
    ue(value) {
      const v = value + 1;
      let len = 0;
      for (let t = v; t > 1; t >>= 1) len += 1;
      for (let i = 0; i < len; i++) push(0);
      for (let i = len; i >= 0; i--) push((v >> i) & 1);
    },
    // Signed exp-Golomb.
    se(value) {
      this.ue(value <= 0 ? -2 * value : 2 * value - 1);
    },
    flush() {
      // rbsp_trailing_bits: stop bit then zero pad to a byte boundary.
      push(1);
      while (n !== 0) push(0);
      return Uint8Array.from(out);
    },
    get byteLength() {
      return out.length;
    },
  };
}

// Emulation prevention: after two zero bytes, any byte <= 3 gets a 0x03
// inserted, so a decoder never sees a false start code inside the NAL.
function withEmulationPrevention(rbsp) {
  const out = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

// Build an SPS NAL (header byte included) declaring exactly width x height.
// frame_mbs_only is always 1, so the crop is expressed in the map unit only.
export function spsNal({ w, h, level = 40, profileIdc = 66 }) {
  const mbW = Math.ceil(w / 16) - 1;
  const mbH = Math.ceil(h / 16) - 1;
  const cropRight = ((mbW + 1) * 16 - w) / 2;
  const cropBottom = ((mbH + 1) * 16 - h) / 2;
  if (!Number.isInteger(cropRight) || !Number.isInteger(cropBottom)) {
    throw new Error(`width/height must be even for a chroma-aligned crop: ${w}x${h}`);
  }
  const hasCrop = cropRight !== 0 || cropBottom !== 0;

  const bw = bitWriter();
  bw.bits(profileIdc, 8);
  bw.bits(0, 8); // constraint flags
  bw.bits(level, 8);
  bw.ue(0); // seq_parameter_set_id
  // profileIdc 66 (baseline) skips the chroma_format block entirely.
  bw.ue(0); // log2_max_frame_num_minus4
  bw.ue(0); // pic_order_cnt_type
  bw.ue(0); // log2_max_pic_order_cnt_lsb_minus4
  bw.ue(1); // max_num_ref_frames
  bw.bit(0); // gaps_in_frame_num_value_allowed_flag
  bw.ue(mbW);
  bw.ue(mbH);
  bw.bit(1); // frame_mbs_only_flag
  bw.bit(1); // direct_8x8_inference_flag
  bw.bit(hasCrop ? 1 : 0);
  if (hasCrop) {
    bw.ue(0); // left
    bw.ue(cropRight);
    bw.ue(0); // top
    bw.ue(cropBottom);
  }
  const rbsp = bw.flush();

  const nal = [0x67]; // forbidden_zero=0, nal_ref_idc=3, nal_unit_type=7
  for (const b of withEmulationPrevention(rbsp)) nal.push(b);
  return Uint8Array.from(nal);
}

// Wrap payload bytes in 188-byte TS packets (pid 0x100, payload only, PUSI
// clear so no PES header is stripped by the parser).
export function tsPackets(payload, { pid = 0x100, packets = null } = {}) {
  const body = [];
  const total = Math.max(payload.length, 1);
  for (let i = 0; i < total; i += 184) {
    body.push(payload.subarray(i, i + 184));
    if (packets != null && body.length >= packets) break;
  }
  const out = new Uint8Array(body.length * 188);
  body.forEach((chunk, index) => {
    const offset = index * 188;
    out[offset] = 0x47;
    out[offset + 1] = (pid >> 8) & 0x1f;
    out[offset + 2] = pid & 0xff;
    out[offset + 3] = 0x10; // no adaptation, continuity counter 0
    out.fill(0xff, offset + 4);
    out.set(chunk, offset + 4);
  });
  return out;
}

// A TS buffer whose video payload starts with `00 00 00 01` + SPS.
export function tsWithSps({ w, h, level = 40, profileIdc = 66, prefix = [] } = {}) {
  const start = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);
  const nal = spsNal({ w, h, level, profileIdc });
  const payload = new Uint8Array(prefix.length + start.length + nal.length);
  payload.set(prefix, 0);
  payload.set(start, prefix.length);
  payload.set(nal, prefix.length + start.length);
  return tsPackets(payload);
}

// Annex-B form (no TS wrapping) — the parser falls back to this when no
// packet in the buffer looks like a TS packet.
export function annexBWithSps({ w, h, level = 40, profileIdc = 66 } = {}) {
  const start = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);
  const nal = spsNal({ w, h, level, profileIdc });
  const out = new Uint8Array(start.length + nal.length);
  out.set(start, 0);
  out.set(nal, start.length);
  return out;
}
