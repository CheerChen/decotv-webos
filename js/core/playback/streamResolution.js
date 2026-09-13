// streamResolution.js — read a stream's REAL coded resolution from the
// on-device service.
//
// Why not the labels: an upstream's `RESOLUTION=` tag and the server probe's
// `quality` field both come from the playlist text, and one measured stream
// declared 1080x608 while its bitstream carried 1920x1080. The service reads
// the bitstream (master → best variant → segment head → H.264 SPS, decrypting
// AES-128 sources when needed), so this module is only the transport.
//
// The read needs the service, exactly like the ad-filter proxy: without it
// (dev preview, non-webOS, bind failure) every source stays unmeasured and
// the caller falls back to the labels. "Unmeasured" is unknown, never low
// quality — a source must not be ranked down for a failed read.

import { getM3u8ProxyPort } from "../network/lunaTransport.js";

export const RESOLUTION_TIMEOUT_MS = 9000;
// Coded width at or above this counts as 1080p-class. A label like "1080p"
// cannot express this: a 1920x608 letterboxed rip is not full HD.
export const FULL_HD_WIDTH = 1900;

// One port lookup per burst: a round probes ~30 sources at once, and each
// Luna call costs a round trip. The port can change on a service rebind, and
// a stale one only costs a failed read (the next round re-queries).
const PORT_TTL_MS = 10000;
let portCache = { port: 0, at: 0 };

async function resolvePort() {
  const now = Date.now();
  if (portCache.port && now - portCache.at < PORT_TTL_MS) return portCache.port;
  const port = await getM3u8ProxyPort();
  portCache = { port: Number(port) || 0, at: now };
  return portCache.port;
}

/**
 * @param {string} playUrl playable HLS URL (variant or master)
 * @param {{ port?: number, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ w: number, h: number, level: number } | null>} null when
 *   the stream could not be measured
 */
export async function readStreamResolution(playUrl, opts = {}) {
  if (!playUrl) return null;
  const port = opts.port || await resolvePort();
  if (!port) return null;

  const timeoutMs = opts.timeoutMs || RESOLUTION_TIMEOUT_MS;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const onOuterAbort = () => {
    try { controller?.abort(); } catch (_) {}
  };
  if (opts.signal) {
    if (opts.signal.aborted) return null;
    opts.signal.addEventListener?.("abort", onOuterAbort);
  }
  const timer = setTimeout(onOuterAbort, timeoutMs);
  try {
    const url = `http://127.0.0.1:${port}/probe?url=${encodeURIComponent(playUrl)}`;
    const res = await fetch(url, {
      signal: controller?.signal,
      cache: "no-store",
      credentials: "omit",
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !body.ok || !body.w || !body.h) return null;
    return { w: Number(body.w), h: Number(body.h), level: Number(body.level) || 0 };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

// True only for a measured stream that clears the full-HD width. An
// unmeasured stream is not full HD by this test, but callers must not read
// that as "bad" — the water level is a shortcut, not a verdict.
export function isFullHdMeasured(result) {
  const width = Number(result?.measuredWidth);
  return Number.isFinite(width) && width >= FULL_HD_WIDTH;
}

export function measuredResolutionLabel(result) {
  const w = Number(result?.measuredWidth);
  const h = Number(result?.measuredHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "";
  return `${w}×${h}`;
}
