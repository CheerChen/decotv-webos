// sourceRanking.js — playback source ranking, ported from DecoTV
// src/lib/player/source-ranking.ts. Used to pick the best source after probing.

const STARTUP_TIE_BREAKER_MS = 750;

function comparePositiveLowerFirst(a, b) {
  const hasA = typeof a === "number" && Number.isFinite(a) && a > 0;
  const hasB = typeof b === "number" && Number.isFinite(b) && b > 0;
  if (hasA !== hasB) return hasA ? -1 : 1;
  return hasA && hasB ? a - b : 0;
}

// Parse a quality label like "1080p", "720p", "4K", "2160p", "未知" into a
// numeric rank so higher resolution sorts first. Returns 0 when unparseable.
// 4K / 2160p → 2160; 1080p → 1080; 720p → 720; 480p → 480; unknown → 0.
export function getQualityRank(result) {
  if (!result) return 0;
  const q = String(result.quality || "").trim();
  if (!q) return 0;
  const upper = q.toUpperCase();
  if (upper === "4K" || upper === "UHD") return 2160;
  // Extract the leading integer (handles "1080p", "720 P", "1920x1080", etc.)
  const m = q.match(/(\d{3,4})\s*[pPkKxX]?/);
  if (m) {
    const n = Number(m[1]);
    // Clamp to sane resolution heights (240..2160)
    if (n >= 240 && n <= 2160) return n;
  }
  return 0;
}

export function hasMeasuredMediaThroughput(result) {
  return Boolean(
    result
    && !result.hasError
    && Number.isFinite(result.speedKBps)
    && (result.speedKBps || 0) > 0
  );
}

export function isVerifiedPlaybackResult(result) {
  return Boolean(
    result
    && !result.hasError
    && (hasMeasuredMediaThroughput(result) || (result.status === "ok" && result.playable))
  );
}

export function isPlayableFallbackResult(result) {
  if (!result || result.hasError || result.mediaType === "page") return false;
  if (isVerifiedPlaybackResult(result)) return true;
  if (result.status !== "partial") return false;
  if (["resolver", "timeout", "manifest", "network"].includes(result.failureKind)) return false;
  return Boolean(result.playable || result.failureKind === "fragment" || (result.pingTime || 0) > 0);
}

export function getPlaybackEvidenceTier(result) {
  if (!result) return 4;
  if (result.hasError || result.status === "failed") return 5;
  if (hasMeasuredMediaThroughput(result)) return 0;
  if (result.status === "ok" && result.playable) return 1;
  if (result.status === "partial" || result.pingTime > 0) return 2;
  return 3;
}

export function comparePlaybackMetrics(a, b) {
  const tierDifference = getPlaybackEvidenceTier(a) - getPlaybackEvidenceTier(b);
  if (tierDifference !== 0) return tierDifference;
  if (!a || !b) return 0;
  // Resolution first: a 1080p source beats a 480p source even if the 480p
  // one has higher throughput — on a TV, picture quality matters more than
  // raw speed as long as the stream is fast enough to sustain the resolution.
  const qualityDifference = getQualityRank(b) - getQualityRank(a);
  if (qualityDifference !== 0) return qualityDifference;
  // Throughput: higher speed wins (can sustain higher bitrate).
  const speedDifference = (b.speedKBps || 0) - (a.speedKBps || 0);
  if (speedDifference !== 0) return speedDifference;
  // Startup time: only counts if the gap exceeds the tie-breaker threshold.
  const startupDifference = comparePositiveLowerFirst(a.startupTimeMs, b.startupTimeMs);
  if (Math.abs(startupDifference) > STARTUP_TIE_BREAKER_MS) return startupDifference;
  if (startupDifference !== 0) return startupDifference;
  // Latency: last tie-breaker.
  return comparePositiveLowerFirst(a.pingTime, b.pingTime);
}

// Build a sort key for a source used to dedupe and index probe results.
export function getSourceProbeKey(source) {
  return `${source.source}-${source.id}`;
}

// Return a copy ordered the same way the source lists are displayed: measured
// sources first, then the best probe result first, with unprobed sources left
// in their original order at the end. The original array is never mutated.
export function rankSourcesByProbe(sources, probeResults = new Map()) {
  const results = probeResults instanceof Map ? probeResults : new Map();
  return (Array.isArray(sources) ? sources : [])
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const ra = results.get(getSourceProbeKey(a.source));
      const rb = results.get(getSourceProbeKey(b.source));
      let order = 0;
      if (!ra && !rb) order = 0;
      else if (!ra) order = 1;
      else if (!rb) order = -1;
      else order = comparePlaybackMetrics(ra, rb);
      // Do not rely on the webOS webview's sort stability for equal metrics or
      // unprobed sources: preserve search order explicitly as the tie-breaker.
      return order || a.index - b.index;
    })
    .map(({ source }) => source);
}

// Choose the highest-ranked source that has not failed at runtime. This is
// deliberately separate from the source array order: search results are not a
// quality ranking, so using `sources.find(...)` would make failover arbitrary.
export function pickBestAvailableSource(
  sources,
  probeResults = new Map(),
  failedSourceKeys = new Set()
) {
  const failed = failedSourceKeys instanceof Set
    ? failedSourceKeys
    : new Set(failedSourceKeys || []);
  return rankSourcesByProbe(sources, probeResults)
    .find((source) => !failed.has(getSourceProbeKey(source))) || null;
}
