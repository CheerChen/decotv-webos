// adSkipScanner.js — pre-scan an HLS playlist for mid-roll ad ranges.
//
// For each #EXT-X-DISCONTINUITY group, fetch the first media segment and read
// coded resolution from the H.264 SPS. The majority resolution by duration is
// treated as the feature; groups whose coded dimensions differ — smaller OR
// larger — become skippable ranges (strict equality, verified against several
// resource-site families: content segments are resolution-uniform, every
// deviating block measured was an ad).
//
// Secondary feature: the group's segment URL signature (host + directory).
// Injected ad assets live in a different storage path than the episode's own
// segments, so a group whose URL host/dir deviates from the duration-weighted
// majority is an ad even when it is encoded at the same resolution (which the
// SPS probe alone would miss).
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
// URL-signature detection only engages when one signature owns more than this
// share of the total duration — otherwise a playlist that legitimately rotates
// CDN hosts group-by-group would classify content groups as ads.
export const SIG_MAJORITY_MIN = 0.5;
// A flagged block shorter than this is treated as encoder noise; only merged
// ranges of at least this length warrant a seek. Real ad blocks measured
// 20-88s across sources, while stray single-segment anomalies run 1-2s.
export const MIN_AD_RANGE_S = 5;

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

// Normalize a segment URL to its host + directory (filename and query
// stripped), e.g. https://cdn.example/2025/1107/4M/hls/a.ts →
// https://cdn.example/2025/1107/4M/hls/.
export function urlSignature(url) {
  try {
    const u = new URL(url);
    const slash = u.pathname.lastIndexOf("/");
    const dir = slash < 0 ? u.pathname : u.pathname.slice(0, slash + 1);
    return `${u.origin}${dir}`;
  } catch (_) {
    return null;
  }
}

// One signature for a whole group; null if any segment URL is unresolvable or
// the group spans mixed directories (then signature detection is skipped for
// it, conservative side).
function groupSignature(urls) {
  let sig = null;
  for (const u of urls) {
    const s = urlSignature(u);
    if (s === null) return null;
    if (sig === null) sig = s;
    else if (sig !== s) return null;
  }
  return sig;
}

/**
 * Parse a media playlist into discontinuity groups.
 * @returns {{ start: number, end: number, duration: number, firstUrl: string, sig: string | null }[]}
 */
export function parseMediaGroups(text, baseUrl) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim());
  const groups = [];
  let groupIndex = 0;
  let t = 0;
  let curDur = null;
  let current = { start: 0, duration: 0, firstUrl: "", urls: [] };

  const pushCurrent = () => {
    if (current.duration > 0 && current.firstUrl) {
      groups.push({
        start: current.start,
        end: current.start + current.duration,
        duration: current.duration,
        firstUrl: current.firstUrl,
        sig: groupSignature(current.urls)
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      pushCurrent();
      groupIndex += 1;
      current = { start: t, duration: 0, firstUrl: "", urls: [] };
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
      current.urls.push(abs);
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
 *   sigAdGroups: number,
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

  // Dynamic ad-stitching check: a playlist that mixes multiple date-prefixed
  // storage paths *may* be re-randomizing ad insertion points on every request.
  // But a source can also stitch ads at fixed positions — that is still
  // scannable. To tell the two apart, fetch the variant a second time and
  // compare: if the segment ordering differs, ad positions are randomized and
  // the pre-scan ranges won't match what the player actually downloads.
  if (isDynamicStitchedPlaylist(text, finalUrl)) {
    let unstable = false;
    try {
      const second = await fetchPlaylistText(finalUrl, signal);
      unstable = second.text !== text;
    } catch (_) {
      // Network hiccup on the confirmation fetch — be conservative and skip.
      unstable = true;
    }
    if (unstable) {
      return {
        ranges: [],
        baseline: null,
        groups: 0,
        probed: 0,
        sigAdGroups: 0,
        elapsedMs: Date.now() - started,
        dynamicStitched: true
      };
    }
    // Same content on re-fetch — ads are stitched at fixed positions, so the
    // pre-scan ranges are valid. Fall through to normal scanning.
  }

  const groups = parseMediaGroups(text, finalUrl);
  if (!groups.length) {
    return {
      ranges: [],
      baseline: null,
      groups: 0,
      probed: 0,
      sigAdGroups: 0,
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

  // URL-signature majority (secondary feature): host+dir weighted by duration.
  // Counts probe-failed groups too — the signature comes from the playlist
  // text, not from segment downloads.
  const sigScores = new Map();
  let sigTotal = 0;
  for (const g of probes) {
    if (g.sig == null) continue;
    sigScores.set(g.sig, (sigScores.get(g.sig) || 0) + g.duration);
    sigTotal += g.duration;
  }
  let baselineSig = null;
  let bestSigScore = 0;
  for (const [sig, score] of sigScores) {
    if (score > bestSigScore) {
      bestSigScore = score;
      baselineSig = sig;
    }
  }
  const sigUsable = baselineSig != null
    && sigTotal > 0
    && bestSigScore / sigTotal > SIG_MAJORITY_MIN;

  const adGroups = [];
  for (const g of probes) {
    // Strict coded-resolution rule: any deviation (smaller or larger) from the
    // duration-weighted baseline is ad material. Probe-failed groups (ok=false)
    // never flag on resolution, so a partial 512KB probe cannot misclassify.
    const resAd = g.ok && baseline && isAdResolution(g.w, g.h, baseline.w, baseline.h);
    const sigAd = sigUsable && g.sig != null && g.sig !== baselineSig;
    if (resAd || sigAd) adGroups.push(g);
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
    ranges: ranges.filter((r) => r.end - r.start >= MIN_AD_RANGE_S),
    baseline,
    groups: groups.length,
    probed: probes.filter((p) => p.ok).length,
    sigAdGroups: sigUsable ? adGroups.filter((g) => g.sig != null && g.sig !== baselineSig).length : 0,
    elapsedMs: Date.now() - started
  };
}

// Detect dynamic ad-stitching: a single media playlist whose segment URLs
// span multiple date-prefixed storage paths (e.g. /20230914/.../879kb/ for
// content and /20260811/.../10138kb/ for ads). Such sources re-randomize ad
// insertion points on every request, so a pre-scan's ranges never match the
// playlist the player's native HLS pipeline actually downloads.
export function isDynamicStitchedPlaylist(text, baseUrl) {
  const dates = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      const u = new URL(t, baseUrl);
      const m = u.pathname.match(/^\/(\d{8})\//);
      if (m) dates.add(m[1]);
    } catch (_) {}
  }
  return dates.size > 1;
}

export function isHlsPlayUrl(url) {
  if (!url) return false;
  if (/\/api\/proxy\/m3u8/i.test(url)) return true;
  return /\.m3u8(\?|#|$)/i.test(url);
}
