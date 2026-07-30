// adSkipScanner.js — pre-scan an HLS playlist for mid-roll ad ranges.
//
// For each #EXT-X-DISCONTINUITY group, fetch the first media segment and read
// coded resolution from the H.264 SPS. The majority resolution by duration is
// treated as the feature; clearly smaller groups become skippable ranges.
//
// Runs in the background after play starts so the user can measure whether
// the extra bandwidth stalls startup. Cancel via AbortSignal on episode change.

import { resolutionFromTsBuffer } from "./tsResolution.js";
import { isAdResolution } from "./adSkipDetector.js";

export const SCAN_CONCURRENCY = 2;
// Cap how much of each segment we download — SPS is near the start.
export const SEGMENT_PROBE_BYTES = 512 * 1024;
export const SEGMENT_TIMEOUT_MS = 10000;
export const PLAYLIST_TIMEOUT_MS = 12000;

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [opts]
 */
async function fetchWithTimeout(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || PLAYLIST_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: opts.signal || ctrl.signal,
      credentials: "omit",
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).href;
  } catch (_) {
    return ref;
  }
}

/**
 * Parse a media playlist into discontinuity groups.
 * @returns {{ start: number, end: number, duration: number, firstUrl: string }[]}
 */
export function parseMediaGroups(text, baseUrl) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim());
  const groups = [];
  let groupIndex = 0;
  let t = 0;
  let curDur = null;
  let current = { start: 0, duration: 0, firstUrl: "" };

  const pushCurrent = () => {
    if (current.duration > 0 && current.firstUrl) {
      groups.push({
        start: current.start,
        end: current.start + current.duration,
        duration: current.duration,
        firstUrl: current.firstUrl
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      pushCurrent();
      groupIndex += 1;
      current = { start: t, duration: 0, firstUrl: "" };
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const m = line.match(/#EXTINF:([\d.]+)/);
      curDur = m ? parseFloat(m[1]) : 0;
      continue;
    }
    if (line && !line.startsWith("#") && curDur != null) {
      const abs = resolveUrl(baseUrl, line);
      if (!current.firstUrl) current.firstUrl = abs;
      current.duration += curDur;
      t += curDur;
      curDur = null;
    }
  }
  pushCurrent();
  return groups;
}

/** If master playlist, return first variant URL; else null. */
export function firstVariantUrl(text, baseUrl) {
  if (!String(text).includes("#EXT-X-STREAM-INF")) return null;
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) return resolveUrl(baseUrl, next);
    }
  }
  return null;
}

async function fetchPlaylistText(url, signal) {
  const res = await fetchWithTimeout(url, { signal, timeoutMs: PLAYLIST_TIMEOUT_MS });
  const text = await res.text();
  // Prefer final response URL for relative refs (after redirects).
  const finalUrl = res.url || url;
  return { text, finalUrl };
}

async function probeSegmentResolution(url, signal) {
  const res = await fetchWithTimeout(url, {
    signal,
    timeoutMs: SEGMENT_TIMEOUT_MS,
    headers: { Range: `bytes=0-${SEGMENT_PROBE_BYTES - 1}` }
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  return resolutionFromTsBuffer(buf);
}

async function mapPool(items, concurrency, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Build skippable ad ranges from a playable HLS URL (variant or master).
 *
 * @param {string} playUrl
 * @param {{ signal?: AbortSignal, concurrency?: number }} [opts]
 * @returns {Promise<{
 *   ranges: { start: number, end: number }[],
 *   baseline: { w: number, h: number } | null,
 *   groups: number,
 *   probed: number,
 *   elapsedMs: number
 * }>}
 */
export async function scanAdRanges(playUrl, opts = {}) {
  const started = Date.now();
  const signal = opts.signal;
  const concurrency = opts.concurrency || SCAN_CONCURRENCY;

  let { text, finalUrl } = await fetchPlaylistText(playUrl, signal);
  const variant = firstVariantUrl(text, finalUrl);
  if (variant) {
    ({ text, finalUrl } = await fetchPlaylistText(variant, signal));
  }

  if (!text.trimStart().startsWith("#EXTM3U")) {
    throw new Error("Not an m3u8 playlist");
  }

  const groups = parseMediaGroups(text, finalUrl);
  if (!groups.length) {
    return {
      ranges: [],
      baseline: null,
      groups: 0,
      probed: 0,
      elapsedMs: Date.now() - started
    };
  }

  const probes = await mapPool(
    groups,
    concurrency,
    async (g) => {
      try {
        const dims = await probeSegmentResolution(g.firstUrl, signal);
        return { ...g, w: dims?.w || 0, h: dims?.h || 0, ok: Boolean(dims?.w) };
      } catch (_) {
        return { ...g, w: 0, h: 0, ok: false };
      }
    },
    signal
  );

  // Majority resolution weighted by group duration.
  const areaKey = (w, h) => `${w}x${h}`;
  const scores = new Map();
  for (const g of probes) {
    if (!g.ok) continue;
    const k = areaKey(g.w, g.h);
    scores.set(k, (scores.get(k) || 0) + g.duration);
  }
  let baseline = null;
  let bestScore = 0;
  for (const [k, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      const [w, h] = k.split("x").map(Number);
      baseline = { w, h };
    }
  }

  const adGroups = [];
  if (baseline) {
    for (const g of probes) {
      if (!g.ok) continue;
      if (isAdResolution(g.w, g.h, baseline.w, baseline.h)) {
        adGroups.push(g);
      }
    }
  }

  // Merge consecutive ad groups into ranges.
  const ranges = [];
  for (const g of adGroups.sort((a, b) => a.start - b.start)) {
    const last = ranges[ranges.length - 1];
    if (last && Math.abs(last.end - g.start) < 0.25) {
      last.end = g.end;
    } else {
      ranges.push({ start: g.start, end: g.end });
    }
  }

  return {
    ranges,
    baseline,
    groups: groups.length,
    probed: probes.filter((p) => p.ok).length,
    elapsedMs: Date.now() - started
  };
}

export function isHlsPlayUrl(url) {
  if (!url) return false;
  if (/\/api\/proxy\/m3u8/i.test(url)) return true;
  return /\.m3u8(\?|#|$)/i.test(url);
}
