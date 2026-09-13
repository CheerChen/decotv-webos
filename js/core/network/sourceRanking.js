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
//
// This is a LABEL, and labels lie: a measured stream has been seen declaring
// 1080x608 while carrying 1920x1080. It also cannot express the difference
// that matters most (a 1920x608 letterboxed rip is not 1080p, yet its label
// parses to 1920). Used only as a weak fallback below getMeasuredWidth.
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

// The coded width read from the bitstream, or 0 when the stream could not be
// measured. 0 must never be read as "low quality" — it means unknown.
export function getMeasuredWidth(result) {
  const w = Number(result?.measuredWidth);
  return Number.isFinite(w) && w > 0 ? w : 0;
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
  //
  // Measured coded width outranks the upstream label: a stream the service
  // actually read is evidence, a `RESOLUTION=` tag is a claim (one measured
  // stream declared 1080x608 while carrying 1920x1080). A source whose read
  // failed scores 0 here and keeps its label as the next tie-break.
  const measuredDifference = getMeasuredWidth(b) - getMeasuredWidth(a);
  if (measuredDifference !== 0) return measuredDifference;
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

// Return the display label for episode `index` of `source`.
// When the source provides `episodes_titles` AND they are version/language
// labels (e.g. ["HD国语", "HD粤语"]), use the title directly. When the
// titles are just episode-number strings (e.g. ["第01集", "第02集"]) or
// absent, fall back to "第 N 集".
export function episodeLabel(source, index) {
  if (hasVersionLabels(source)) {
    const titles = source.episodes_titles;
    if (titles[index]) return titles[index];
  }
  return `第 ${index + 1} 集`;
}

// True when the source uses episodes_titles as version/language labels
// rather than sequential episode numbers (e.g. a movie with 国语/粤语 cuts).
// Heuristic: titles exist, match episodes length, and at least one title
// does NOT match the "第N集" / "第 NN 集" / plain-number pattern that
// resource sites use for normal sequential episodes.
var EP_NUM_RE = /^第?\s*0*\d+\s*[集话話期回]$/;
var PURE_NUM_RE = /^0*\d+$/;
export function hasVersionLabels(source) {
  const titles = source && Array.isArray(source.episodes_titles) ? source.episodes_titles : null;
  if (!titles || titles.length === 0) return false;
  if (titles.length !== (source.episodes || []).length) return false;
  // If every title looks like a sequential episode number (第N集 / N集 /
  // plain number), it's a normal series — not version labels.
  var allEpisodeNumbers = titles.every(function (t) {
    var s = String(t || "").trim();
    return EP_NUM_RE.test(s) || PURE_NUM_RE.test(s);
  });
  return !allEpisodeNumbers;
}
