"use strict";

// aes128.js — the AES-128-CBC window decrypt the segment prober needs.
//
// Ten of thirty reachable sources in one measured batch were AES-128
// encrypted, and on those the SPS is unreadable without decrypting first, so
// the coded-signature classification would silently degrade to URL
// signatures only. Key material comes from the playlist's #EXT-X-KEY tag
// (see m3u8AdFilter.parseKeyTag); the IV is the tag's explicit IV when
// present, otherwise the segment's media sequence number per HLS.

var crypto = require("crypto");

var BLOCK_BYTES = 16;

// HLS default IV: the media sequence number as a 128-bit big-endian integer,
// so the value occupies the last four bytes and a value above 2^32 keeps its
// high half in bytes 8..11.
function ivFromSequence(seq) {
  var iv = Buffer.alloc(BLOCK_BYTES);
  var value = Math.max(0, Math.floor(Number(seq) || 0));
  var high = Math.floor(value / 4294967296);
  var low = value % 4294967296;
  iv.writeUInt32BE(high, 8);
  iv.writeUInt32BE(low, 12);
  return iv;
}

function ivFromHex(hex) {
  if (!hex || hex.length !== BLOCK_BYTES * 2) return null;
  var iv = Buffer.from(hex, "hex");
  return iv.length === BLOCK_BYTES ? iv : null;
}

function resolveIv(key, seq) {
  if (!key) return null;
  return ivFromHex(key.ivHex) || ivFromSequence(seq);
}

// Decrypt a prefix window. No padding is expected or removed: a probe window
// is a prefix of a segment, so its trailing bytes are not a complete block
// and cannot be decrypted — the SPS lives at the head, so they are not
// needed. Returns null when the key or IV is unusable.
function decryptCbcWindow(ciphertext, key, iv) {
  if (!key || !iv) return null;
  if (!Buffer.isBuffer(key) || key.length !== BLOCK_BYTES) return null;
  if (!Buffer.isBuffer(iv) || iv.length !== BLOCK_BYTES) return null;
  if (!ciphertext || !ciphertext.length) return null;
  var whole = Math.floor(ciphertext.length / BLOCK_BYTES) * BLOCK_BYTES;
  if (whole <= 0) return null;
  try {
    var decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);
    var head = decipher.update(ciphertext.subarray(0, whole));
    var tail = decipher.final();
    return tail && tail.length ? Buffer.concat([head, tail]) : head;
  } catch (_) {
    return null;
  }
}

module.exports = {
  BLOCK_BYTES: BLOCK_BYTES,
  ivFromSequence: ivFromSequence,
  ivFromHex: ivFromHex,
  resolveIv: resolveIv,
  decryptCbcWindow: decryptCbcWindow
};
