// preferEngine.js — source filtering, probing, ranking, and autoplay policy.

import {
  comparePlaybackMetrics,
  getMeasuredWidth,
  getQualityRank,
  getSourceProbeKey,
  isPlayableFallbackResult,
  isVerifiedPlaybackResult,
} from "./sourceRanking.js";
import { FULL_HD_WIDTH, isFullHdMeasured } from "../playback/streamResolution.js";

export const PROBE_TIMEOUT_MS = 8000;
export const PREFER_CONCURRENCY = 8;
// While a video plays, a probe round that has not finished keeps going on
// this many workers, so it completes without starving the stream.
export const PREFER_PLAYBACK_CONCURRENCY = 2;
export const PREFER_MAX_WAIT_MS = 12000;
// A run is aborted only when NO probe completes for this long. Each probe is
// already bounded (probe timeout + resolution read), so this only catches a
// hung run; a total-time cap would cut a slow-but-progressing round short.
export const PREFER_IDLE_ABORT_MS = 60000;
export const PREFER_MIN_VERIFIED_FOR_AUTOPLAY = 4;
// Start as soon as one source is MEASURED at full-HD coded width.
export const PREFER_FULL_HD_WIDTH = FULL_HD_WIDTH;
// Legacy label threshold, kept for sources nothing has measured: without the
// service (dev preview, non-webOS, bind failure) no stream can be read, and a
// label is all there ever was. A measured stream never falls back to this —
// its width is the answer, even when the answer is "not full HD".
export const PREFER_QUALITY_SHORTCUT_RANK = 1080;

// Whether a probe result is good enough to start on immediately.
export function hitsQualityShortcut(result, labelShortcutRank = PREFER_QUALITY_SHORTCUT_RANK) {
  if (isFullHdMeasured(result)) return true;
  if (getMeasuredWidth(result) > 0) return false;
  return getQualityRank(result) >= labelShortcutRank;
}

// The prefer session: the one live record of a work's source search and
// probing, shared by detail and player. Both hold the SAME objects — the
// probe Map the engine writes into, the source the player last switched
// to, the sources whose playback failed — so a probe finishing while the
// player is up, or a failover in the player, is seen by the other screen
// without copying. One session at a time (the work being watched).
let preferSession = null;

export function preferCacheKey(title, year) {
  return `p:${title || ""}|${year || ""}`;
}

// A fresh session for a new visit (fresh search): drops any earlier one.
export function startPreferSession(title, year) {
  preferSession = {
    key: preferCacheKey(title, year),
    sources: [],
    probeResults: new Map(),
    currentSourceKey: "",
    failedSourceKeys: new Set(),
  };
  return preferSession;
}

// The current session for this work, if it already found sources.
export function getPreferSession(title, year) {
  const key = preferCacheKey(title, year);
  return preferSession?.key === key && preferSession.sources.length ? preferSession : null;
}

export function clearPreferSession() {
  preferSession = null;
}

// Title identity for matching: letters and digits only. Resource sites spell
// one catalog title HTML-escaped ("&amp;"), bare ("&") or with no punctuation
// at all, in full-width or half-width forms; spaces-only stripping missed
// every one of those and the page showed no sources.
const HTML_ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g;

function decodeEntity(_, body) {
  let code = NaN;
  if (/^#x/i.test(body)) code = parseInt(body.slice(2), 16);
  else if (body.charAt(0) === "#") code = parseInt(body.slice(1), 10);
  // Named entities in titles are punctuation (&amp; &middot; &nbsp; ...),
  // which is dropped below anyway.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}

export function normalizeTitle(s) {
  return String(s || "")
    .replace(HTML_ENTITY, decodeEntity)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
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

// Season / part words a catalog appends that the sites write elsewhere or
// not at all: "第二季", "第二&第三赛段", "外传篇", "Part.2", "Season 3",
// "2nd Season".
const SEASON_WORD = /^((第.+(季|期|部|章|篇|赛段|クール))|(.+(篇|赛段))|(part\.?\s*\d+)|(season\s*\d+)|(\d+(st|nd|rd|th)(season)?))$/i;

function yearOf(value) {
  const m = String(value || "").trim().slice(0, 4);
  return /^\d{4}$/.test(m) ? Number(m) : null;
}

// The last rung: every word of the title in the result's title, in any
// order, season words set aside, and the same year. Catalogs (Bangumi) list
// "<副题> <题名> 第二&第三赛段" where the sites list "<题名><副题>". Looser than
// the rungs above, so the year must agree and a one-word title has nothing
// to reorder.
function byWords(results, title, year) {
  const target = yearOf(year);
  if (target === null) return [];
  const words = String(title || "").trim().split(/\s+/)
    .filter((w) => !SEASON_WORD.test(w))
    .map(normalizeTitle)
    .filter(Boolean);
  if (words.length < 2) return [];
  return results.filter((r) => {
    const t = normalizeTitle(r.title);
    return yearOf(r.year) === target && words.every((w) => t.includes(w));
  });
}

// Title/year strictness ladder, first non-empty rung wins:
//   exact title + year → title-prefixed + year → reordered words + year.
// Every rung requires the year to agree (blank years on either side pass).
// There is deliberately no any-year rung: a same-title entry from another
// year is another work far more often than a mis-dated listing (live
// search, 2026-10: a film's title matched a same-named short series from
// two years earlier), and playing the wrong work is worse than "no source".
//
// Within the winning rung the episode-count type inferred from the first
// raw hit is preferred (tv: >1 episode, movie: exactly 1); when no source
// in the rung satisfies it, the rung is returned as is.
export function filterSearchSources(results, title, year) {
  const all = Array.isArray(results) ? results : [];
  const searchType = all.length ? inferSearchType(all[0].episodes) : null;
  const want = normalizeTitle(title);
  const yearOk = (source) => matchesYear(source.year, year);
  const byExact = want ? all.filter((r) => normalizeTitle(r.title) === want) : [];
  // Prefix, not substring: the rung exists for "<题名> 第N季" listings, where
  // the title always leads. A substring match let a short title reach an
  // unrelated work that merely contains it (live search, 2026-10: a
  // two-character title matched 56 sources of an unrelated series whose
  // title contained those two characters, where the title itself had none).
  const byPrefix = want ? all.filter((r) => normalizeTitle(r.title).startsWith(want)) : [];

  let rung = byExact.filter(yearOk);
  if (!rung.length) rung = byPrefix.filter(yearOk);
  if (!rung.length) rung = byWords(all, title, year);

  if (!searchType) return rung;
  const typed = rung.filter((source) => {
    const episodeCount = Array.isArray(source.episodes) ? source.episodes.length : 0;
    return searchType === "tv" ? episodeCount > 1 : episodeCount === 1;
  });
  return typed.length ? typed : rung;
}

// Search queries to try, in order, when the title itself finds nothing: the
// title with its spaces removed, then its part before the first space.
// Resource sites split a spaced query and match its parts loosely —
// "<题名> 第二季" returned a thousand unrelated hits while "<题名>第二季"
// returned the season. Results are still filtered against the full title,
// so a shorter query only widens what is fetched, not what matches.
const MIN_QUERY_CODE_POINTS = 2;

export function retryQueries(title) {
  const trimmed = String(title || "").trim();
  if (!/\s/.test(trimmed)) return [];
  const joined = trimmed.replace(/\s+/g, "");
  const head = trimmed.split(/\s/)[0].trim();
  return [...new Set([joined, head])]
    .filter((q) => [...q].length >= MIN_QUERY_CODE_POINTS);
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
  measureResolution = null,
  isStale = () => false,
  canAutoPlay = () => true,
  onSources,
  onProgress,
  onPick,
  onDone,
  concurrency = PREFER_CONCURRENCY,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  maxWaitMs = PREFER_MAX_WAIT_MS,
  idleAbortMs = PREFER_IDLE_ABORT_MS,
  minVerifiedForAutoplay = PREFER_MIN_VERIFIED_FOR_AUTOPLAY,
  qualityShortcutRank = PREFER_QUALITY_SHORTCUT_RANK,
} = {}) {
  let sources = Array.isArray(initialSources) ? initialSources : [];
  if (!Array.isArray(initialSources)) {
    for (const query of [title, ...retryQueries(title)]) {
      const data = await searchVideos(query);
      if (isStale()) break;
      sources = filterSearchSources(data?.results, title, year);
      if (sources.length) break;
    }
  }
  // Written in place: the caller's Map is the session's, which the player
  // reads while a round is still running.
  const probeResults = existingProbeResults instanceof Map ? existingProbeResults : new Map();
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

  // `concurrency` is a number or a function read before each new probe, so
  // a caller can narrow a running round (e.g. while a video plays).
  const limit = typeof concurrency === "function" ? concurrency : () => concurrency;
  const controller = new AbortController();
  let idleTimer = null;
  const armIdleAbort = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleAbortMs);
  };
  armIdleAbort();
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

  // Read the stream's real resolution through the injected reader. Skips the
  // cases where there is provably nothing to read (no address, or a share
  // page the server probe could not resolve into a stream) so a dead source
  // does not cost an extra round trip.
  const measureStream = async (probe, episodeUrl) => {
    if (!measureResolution) return null;
    if (probe?.failureKind === "empty" || probe?.mediaType === "page") return null;
    const target = probe?.playbackUrl || probe?.resolvedUrl || episodeUrl;
    if (!target) return null;
    try {
      return await measureResolution(target, controller.signal);
    } catch (_) {
      return null;
    }
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
      // Real coded resolution, read from the bitstream by the on-device
      // service. Runs AFTER the server probe so no source is ever held back
      // by it, and is attempted even when the server probe failed: a probe
      // failure usually means the CDN rate-limited the probe, not that the
      // stream is unplayable, and a measured width is the strongest ranking
      // evidence available.
      const measured = await measureStream(probe, episodeUrl);
      if (isStale()) return { source, testResult: { stale: true } };
      if (measured) {
        probe.measuredWidth = measured.w;
        probe.measuredHeight = measured.h;
      }
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

  // Worker `slot` stops taking new sources once the limit drops to it or
  // below; the remaining workers finish the round.
  const worker = async (slot) => {
    while (!controller.signal.aborted) {
      if (isStale()) return;
      if (slot >= Math.max(1, limit())) return;
      const i = nextIndex++;
      if (i >= pending.length) return;
      const result = await probeOne(pending[i]);
      if (result.testResult?.stale) return;
      armIdleAbort();
      results.push(result);
      probeDone++;
      if (isVerifiedPlaybackResult(result.testResult)
        && (result.testResult.startupTimeMs || Infinity) <= probeTimeoutMs) {
        verifiedCount++;
      }
      if (isVerifiedPlaybackResult(result.testResult)
        && hitsQualityShortcut(result.testResult, qualityShortcutRank)) {
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
    await Promise.all(Array.from({ length: Math.min(limit(), pending.length) }, (_, slot) => worker(slot)));
  } finally {
    clearTimeout(idleTimer);
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
