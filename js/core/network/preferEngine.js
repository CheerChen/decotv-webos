// preferEngine.js — source filtering, probing, ranking, and autoplay policy.

import {
  comparePlaybackMetrics,
  getQualityRank,
  getSourceProbeKey,
  isPlayableFallbackResult,
  isVerifiedPlaybackResult,
} from "./sourceRanking.js";

export const PROBE_TIMEOUT_MS = 8000;
export const PREFER_CONCURRENCY = 8;
export const PREFER_MAX_WAIT_MS = 12000;
export const PREFER_BACKGROUND_MAX_MS = 60000;
export const PREFER_MIN_VERIFIED_FOR_AUTOPLAY = 4;
export const PREFER_QUALITY_SHORTCUT_RANK = 1080;

let preferCache = null;

export function preferCacheKey(title, year) {
  return `p:${title || ""}|${year || ""}`;
}

export function savePreferCache({ title, year, sources, probeResults, currentSourceKey }) {
  if (!Array.isArray(sources) || !sources.length) return;
  preferCache = {
    key: preferCacheKey(title, year),
    sources,
    probeResults: Array.from(probeResults instanceof Map ? probeResults.entries() : probeResults || []),
    currentSourceKey: currentSourceKey || "",
  };
}

export function getPreferCache(title, year) {
  const key = preferCacheKey(title, year);
  return preferCache?.key === key && preferCache.sources?.length ? preferCache : null;
}

export function clearPreferCache() {
  preferCache = null;
}

export function normalizeTitle(s) {
  return String(s || "").replaceAll(" ", "").toLowerCase();
}

export function matchesYear(candidateYear, requestedYear) {
  const y = String(requestedYear || "").trim();
  const cy = String(candidateYear || "").trim();
  if (!y || !cy) return true;
  return cy.includes(y) || y.includes(cy);
}

export function inferSearchType(episodes) {
  if (!Array.isArray(episodes)) return null;
  return episodes.length > 1 ? "tv" : "movie";
}

export function filterSearchSources(results, title, year) {
  const all = Array.isArray(results) ? results : [];
  const searchType = all.length ? inferSearchType(all[0].episodes) : null;
  const matches = (source, enforceType) => {
    if (normalizeTitle(source.title) !== normalizeTitle(title)) return false;
    if (!matchesYear(source.year, year)) return false;
    if (!enforceType || !searchType) return true;
    const episodeCount = Array.isArray(source.episodes) ? source.episodes.length : 0;
    if (searchType === "tv" && episodeCount <= 1) return false;
    if (searchType === "movie" && episodeCount !== 1) return false;
    return true;
  };
  return all.filter((source) => matches(source, true)).length
    ? all.filter((source) => matches(source, true))
    : all.filter((source) => matches(source, false));
}

export function pickBestPreferSource(sources, probeResults, candidates = null) {
  const pool = Array.isArray(candidates) ? candidates : sources;
  const measured = pool
    .map((source) => ({ source, testResult: probeResults.get(getSourceProbeKey(source)) }))
    .filter((entry) => entry.testResult);
  const verified = measured.filter((entry) => isVerifiedPlaybackResult(entry.testResult));
  const selectable = verified.length
    ? verified
    : measured.filter((entry) => isPlayableFallbackResult(entry.testResult));
  if (!selectable.length) return null;
  selectable.sort((a, b) => comparePlaybackMetrics(a.testResult, b.testResult));
  return selectable[0].source;
}

function bestFromResults(sources, results) {
  const verified = results.filter((entry) => isVerifiedPlaybackResult(entry.testResult));
  const selectable = verified.length
    ? verified
    : results.filter((entry) => isPlayableFallbackResult(entry.testResult));
  if (!selectable.length) return null;
  selectable.sort((a, b) => comparePlaybackMetrics(a.testResult, b.testResult));
  return selectable[0]?.source || null;
}

export async function runPreferEngine({
  title,
  year,
  autoPlay = false,
  reselect = true,
  initialSources = null,
  existingProbeResults = new Map(),
  episodeIndex = 0,
  searchVideos,
  probePlayback,
  isStale = () => false,
  canAutoPlay = () => true,
  onSources,
  onProgress,
  onPick,
  onDone,
  concurrency = PREFER_CONCURRENCY,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  maxWaitMs = PREFER_MAX_WAIT_MS,
  backgroundMaxMs = PREFER_BACKGROUND_MAX_MS,
  minVerifiedForAutoplay = PREFER_MIN_VERIFIED_FOR_AUTOPLAY,
  qualityShortcutRank = PREFER_QUALITY_SHORTCUT_RANK,
} = {}) {
  const data = initialSources ? null : await searchVideos(title);
  const sources = Array.isArray(initialSources)
    ? initialSources
    : filterSearchSources(data?.results, title, year);
  const probeResults = new Map(existingProbeResults instanceof Map ? existingProbeResults : []);
  if (isStale()) return { sources, probeResults, best: null, autoPlayFired: false, stale: true };
  onSources?.({ sources, probeResults });
  if (!sources.length || isStale()) return { sources, probeResults, best: null, autoPlayFired: false, stale: isStale() };

  const pending = sources.filter((source) => !probeResults.has(getSourceProbeKey(source)));
  if (!pending.length) {
    const best = pickBestPreferSource(sources, probeResults) || sources[0];
    onDone?.({ sources, probeResults, best, autoPlayFired: false, reselect });
    if (autoPlay && canAutoPlay() && !isStale()) onPick?.({ source: best, sources, probeResults, reason: "done" });
    return { sources, probeResults, best, autoPlayFired: autoPlay && canAutoPlay(), stale: false };
  }

  const controller = new AbortController();
  const hardDeadline = setTimeout(() => controller.abort(), backgroundMaxMs);
  const results = [];
  let nextIndex = 0;
  let probeDone = sources.length - pending.length;
  let verifiedCount = 0;
  let autoPlayFired = false;
  let autoPlayDeadlineReached = false;
  let qualityShortcutHit = false;

  const maybeAutoPlay = (bestSoFar, reason = "progress") => {
    if (autoPlayFired || !autoPlay || !canAutoPlay() || isStale()) return;
    if (verifiedCount < minVerifiedForAutoplay
      && probeDone < sources.length
      && !autoPlayDeadlineReached
      && !qualityShortcutHit) return;
    autoPlayFired = true;
    const best = bestFromResults(sources, results) || bestSoFar || sources[0];
    onPick?.({ source: best, sources, probeResults, reason });
  };

  const probeOne = async (source) => {
    const key = getSourceProbeKey(source);
    const episodeUrl = source.episodes?.[episodeIndex];
    if (!episodeUrl) {
      const fail = { hasError: true, status: "failed", failureKind: "empty", message: "没有可用播放地址" };
      probeResults.set(key, fail);
      return { source, testResult: fail };
    }
    try {
      const probe = await probePlayback(episodeUrl, source.source, probeTimeoutMs, controller.signal);
      if (isStale()) return { source, testResult: { stale: true } };
      probeResults.set(key, probe);
      return { source, testResult: probe };
    } catch (error) {
      if (isStale()) return { source, testResult: { stale: true } };
      const fail = controller.signal.aborted
        ? { hasError: true, status: "failed", failureKind: "timeout", message: "测速超时" }
        : { hasError: true, status: "failed", failureKind: "unknown", message: String(error?.message || error) };
      probeResults.set(key, fail);
      return { source, testResult: fail };
    }
  };

  const worker = async () => {
    while (!controller.signal.aborted) {
      if (isStale()) return;
      const i = nextIndex++;
      if (i >= pending.length) return;
      const result = await probeOne(pending[i]);
      if (result.testResult?.stale) return;
      results.push(result);
      probeDone++;
      if (isVerifiedPlaybackResult(result.testResult)
        && (result.testResult.startupTimeMs || Infinity) <= probeTimeoutMs) {
        verifiedCount++;
      }
      if (isVerifiedPlaybackResult(result.testResult)
        && getQualityRank(result.testResult) >= qualityShortcutRank) {
        qualityShortcutHit = true;
      }
      onProgress?.({
        source: result.source,
        result: result.testResult,
        sources,
        probeResults,
        done: probeDone,
        total: sources.length,
      });
      maybeAutoPlay(result.source);
    }
  };

  const softDeadline = setTimeout(() => {
    autoPlayDeadlineReached = true;
    maybeAutoPlay(null, "soft-deadline");
  }, maxWaitMs);

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  } finally {
    clearTimeout(hardDeadline);
    clearTimeout(softDeadline);
  }

  if (isStale()) return { sources, probeResults, best: null, autoPlayFired, stale: true };
  const best = pickBestPreferSource(sources, probeResults) || sources[0];
  onDone?.({ sources, probeResults, best, autoPlayFired, reselect });
  if (!autoPlayFired && autoPlay && canAutoPlay() && !isStale()) {
    autoPlayFired = true;
    onPick?.({ source: best, sources, probeResults, reason: "done" });
  }
  return { sources, probeResults, best, autoPlayFired, stale: false };
}
