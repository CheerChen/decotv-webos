"use strict";

// segmentProbe.js — classify a media playlist's discontinuity groups by
// coded signature (H.264 resolution + level_idc), at request time, so the
// proxy can DELETE the groups instead of leaving the player to seek past
// them.
//
// Why this exists: the URL-signature rule in m3u8AdFilter.js is free but
// blind to ad blocks that live in the SAME directory at the SAME resolution
// as the episode (the same-directory family: ad 1920x1080@level50 vs
// content 1920x1080@level40). Those were only ever catchable by the client's
// background pre-scan, which could do nothing but seek — paying a decoder
// flush, a 0.35s window where ad frames still paint, and a timeline that
// still contains the ads. Here the same classification drives a playlist
// deletion: the player never sees the ad segments at all.
//
// The classification rule is deliberately identical to the client's
// js/core/playback/adSkipScanner.js: duration-weighted majority of the coded
// signature, and ANY deviation (resolution or level_idc) is ad material.
// Two implementations of "what is an ad" would be a correctness hazard, so
// the grouping, the URL signatures and the majority rule all come from
// m3u8AdFilter.analyzeGroups — this module only adds the bytes.
//
// Network access is injected (fetchBytes) so the classification logic is
// testable without a CDN, and so the service keeps ownership of agents,
// UA and timeouts.

var tsResolution = require("./tsResolution.js");
var aes128 = require("./aes128.js");

// Mirrors adSkipScanner.js: a flagged run shorter than this is encoder
// noise, not an ad block. Real ad blocks measured 20-88s across sources;
// stray single-group anomalies run 1-2s. Applied to the MERGED run, so a
// genuine multi-group ad block is never split by one short group.
var MIN_AD_RANGE_S = 5;

// First probe is deliberately small: the SPS sits in the first IDR frame,
// usually within tens of KB, so the common case costs a fraction of the old
// flat 512KB. Only a source that yields nothing gets the bigger window
// (measured: one family needed 192KB+ before its video track was readable).
var FIRST_PROBE_BYTES = 64 * 1024;
var RETRY_PROBE_BYTES = 384 * 1024;
var KEY_MAX_BYTES = 4 * 1024;

// The proxy answers the player's playlist fetch, so probing sits on the
// startup path. The budget stops STARTING new probes; in-flight ones are
// bounded by the fetcher's own timeout. Running out of budget can only
// under-flag (unprobed groups are never classified as ads), which means an
// ad plays — never that content is deleted.
var PROBE_BUDGET_MS = 4000;
// Probes happen before playback, so they do not compete with a playing
// stream; the client scanner's concurrency 2 exists for the opposite case.
var PROBE_CONCURRENCY = 4;

// Segment verdicts are keyed by host + path (query stripped) so a rotated
// signature still hits. 30 "sources" of one title were measured to be 11
// distinct streams sharing a path across hosts — but hosts are kept in the
// key, because a wrong verdict here deletes content.
var SEGMENT_TTL_MS = 10 * 60 * 1000;
var DECISION_TTL_MS = 15 * 60 * 1000;

function segmentKey(url) {
  try {
    var u = new URL(url);
    return u.host + u.pathname;
  } catch (_) {
    return String(url || "");
  }
}

function areaKey(dims) {
  return dims.w + "x" + dims.h + "@" + dims.level;
}

// Any deviation from the duration-weighted baseline is ad material. Same
// predicate as adSkipDetector.isAdResolution on the client.
function deviates(dims, baseline) {
  if (!dims || !baseline) return false;
  return dims.w !== baseline.w || dims.h !== baseline.h || dims.level !== baseline.level;
}

// Duration-weighted majority coded signature over the groups that probed
// cleanly. Probe failures never vote and never flag.
function baselineOf(probes) {
  var scores = {};
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < probes.length; i++) {
    var p = probes[i];
    if (!p.ok) continue;
    var k = areaKey(p.dims);
    scores[k] = (scores[k] || 0) + p.duration;
    if (scores[k] > bestScore) {
      bestScore = scores[k];
      best = k;
    }
  }
  if (!best) return null;
  var m = best.match(/^(\d+)x(\d+)@(\d+)$/);
  return { w: Number(m[1]), h: Number(m[2]), level: Number(m[3]) };
}

// Merge consecutive flagged groups and drop runs below the noise floor.
function adGroupIndices(probes) {
  var sorted = probes.slice().sort(function (a, b) { return a.index - b.index; });
  var out = [];
  var runStart = null;
  var runEnd = null;
  var runDuration = 0;
  var flush = function () {
    if (runStart === null) return;
    if (runDuration >= MIN_AD_RANGE_S) {
      for (var i = runStart; i <= runEnd; i++) out.push(i);
    }
    runStart = null;
    runEnd = null;
    runDuration = 0;
  };
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    if (!p.flagged) { flush(); continue; }
    if (runStart === null || p.index !== runEnd + 1) flush();
    if (runStart === null) { runStart = p.index; runDuration = 0; }
    runEnd = p.index;
    runDuration += p.duration;
  }
  flush();
  return out;
}

// A decision is only reusable while the playlist's group structure is the
// same: same baseline signature, same group count, same per-group signature
// and duration.
function decisionKey(analysis) {
  var parts = [analysis.baselineSig === null ? "-" : analysis.baselineSig];
  for (var i = 0; i < analysis.groups.length; i++) {
    var g = analysis.groups[i];
    parts.push((g.sig === null ? "-" : g.sig) + "|" + g.duration);
  }
  return parts.join("\n");
}

// Whether the coded-signature probe could change the answer at all.
//
// The trigger is "can the URL-signature rule delete anything?", NOT "is
// there a majority signature?" — the same-directory ad family has a perfect
// majority signature (every group shares one directory), so a majority-based
// trigger would skip exactly the family this probe exists for. When no group
// deviates from the majority signature, that rule is blind and the coded
// signature is the only signal left; when it can already delete something,
// the probe would only add latency to the player's playlist fetch.
//
// The trade-off is deliberate: a playlist that carries BOTH a
// different-directory ad (caught by signature) and a same-directory ad
// (only visible to the probe) keeps its second ad here, and the client's
// pre-scan still seek-skips it.
function needsProbe(analysis) {
  var groups = (analysis && analysis.groups) || [];
  if (groups.length < 2) return false;
  var baselineSig = analysis.baselineSig;
  if (!baselineSig) return true;
  for (var i = 0; i < groups.length; i++) {
    var sig = groups[i].sig;
    if (sig !== null && sig !== baselineSig) return false;
  }
  return true;
}

function createSegmentProber(opts) {
  opts = opts || {};
  var fetchBytes = opts.fetchBytes;
  var now = opts.now || function () { return Date.now(); };
  var segmentTtlMs = opts.segmentTtlMs || SEGMENT_TTL_MS;
  var decisionTtlMs = opts.decisionTtlMs || DECISION_TTL_MS;
  var budgetMs = opts.budgetMs || PROBE_BUDGET_MS;
  var concurrency = opts.concurrency || PROBE_CONCURRENCY;
  var firstBytes = opts.firstBytes || FIRST_PROBE_BYTES;
  var retryBytes = opts.retryBytes || RETRY_PROBE_BYTES;

  var segments = {}; // segment key -> { dims, at }
  var keys = {};     // key URI key -> { key, at }
  var decisions = {}; // decision key -> { adGroupIndices, baseline, at }

  function fresh(entry, ttl) {
    return entry && (now() - entry.at) < ttl;
  }

  // A long session would otherwise accumulate one entry per segment of every
  // episode played. Entries are only ever read while fresh, so dropping
  // expired ones is invisible — this just bounds the memory.
  function prune() {
    var pruneOne = function (store, ttl) {
      for (var key in store) {
        if (!fresh(store[key], ttl)) delete store[key];
      }
    };
    pruneOne(segments, segmentTtlMs);
    pruneOne(keys, segmentTtlMs);
    pruneOne(decisions, decisionTtlMs);
  }

  function fetchKey(keyInfo, done) {
    if (!keyInfo || !keyInfo.uri) { done(null); return; }
    var cacheKey = segmentKey(keyInfo.uri);
    if (fresh(keys[cacheKey], segmentTtlMs)) { done(keys[cacheKey].key); return; }
    fetchBytes(keyInfo.uri, KEY_MAX_BYTES, function (err, buf) {
      if (err || !buf || buf.length < aes128.BLOCK_BYTES) { done(null); return; }
      var key = buf.subarray(0, aes128.BLOCK_BYTES);
      keys[cacheKey] = { key: key, at: now() };
      done(key);
    });
  }

  // Read one probe window and, if the segment is encrypted, decrypt it
  // before looking for the SPS.
  function readWindow(group, wantBytes, key, done) {
    fetchBytes(group.firstUrl, wantBytes, function (err, buf) {
      if (err || !buf || !buf.length) { done(null, err ? "fetch" : "empty"); return; }
      var plain = buf;
      if (group.key) {
        var iv = aes128.resolveIv(group.key, group.firstSeq);
        var decrypted = aes128.decryptCbcWindow(buf, key, iv);
        if (!decrypted) { done(null, "decrypt"); return; }
        plain = decrypted;
      }
      var dims = tsResolution.resolutionFromTsBuffer(plain);
      done(dims, dims ? null : "no-sps");
    });
  }

  function probeGroup(group, key, done) {
    var cacheKey = segmentKey(group.firstUrl);
    if (fresh(segments[cacheKey], segmentTtlMs)) {
      done({ dims: segments[cacheKey].dims, cached: true });
      return;
    }
    readWindow(group, firstBytes, key, function (dims, why) {
      if (dims) {
        segments[cacheKey] = { dims: dims, at: now() };
        done({ dims: dims, cached: false });
        return;
      }
      // Only a window that was too small to contain an SPS is worth a second,
      // bigger read. A fetch error or a key/IV problem will not improve.
      if (why !== "no-sps" && why !== "empty") {
        done({ dims: null, cached: false, failure: why });
        return;
      }
      // Nothing readable in the small window — retry once with the big one.
      readWindow(group, retryBytes, key, function (bigDims, bigWhy) {
        if (bigDims) {
          segments[cacheKey] = { dims: bigDims, at: now() };
          done({ dims: bigDims, cached: false });
          return;
        }
        done({ dims: null, cached: false, failure: bigWhy || "no-sps" });
      });
    });
  }

  // Probe a group list with a bounded pool, stopping when the deadline
  // passes. Never throws: a group that cannot be probed is simply unprobed.
  // Each group resolves its OWN key (a playlist may rotate keys), and the
  // key cache makes a shared key cost one fetch.
  function probeAll(groups, deadline, done) {
    var results = [];
    var next = 0;
    var pending = Math.min(concurrency, Math.max(1, groups.length));
    var budgetExceeded = false;
    var finished = 0;
    var active = 0;
    var anyEncrypted = false;

    function startNext() {
      while (active < pending && next < groups.length) {
        if (now() >= deadline) { budgetExceeded = true; break; }
        var group = groups[next++];
        active += 1;
        if (group.key) anyEncrypted = true;
        fetchKey(group.key, function (key) {
          probeGroup(group, key, function (res) {
            active -= 1;
            results.push({
              index: group.index,
              duration: group.duration,
              dims: res.dims,
              ok: Boolean(res.dims),
              cached: res.cached,
              failure: res.failure || null
            });
            startNext();
          });
        });
      }
      if (active === 0 && (next >= groups.length || budgetExceeded)) {
        if (finished) return;
        finished = 1;
        done(results, budgetExceeded, anyEncrypted);
      }
    }

    if (!groups.length) { done([], false, false); return; }
    startNext();
  }

  /**
   * Classify a playlist's groups. `analysis` is the output of
   * m3u8AdFilter.analyzeGroups. Calls back with the group ordinals to delete.
   *
   * @param {{groups: Array, baselineSig: string|null}} analysis
   * @param {function(Error|null, Object)} cb
   */
  function classify(analysis, cb) {
    var started = now();
    var groups = (analysis && analysis.groups) || [];
    if (!groups.length) {
      cb(null, { adGroupIndices: [], probed: 0, failed: 0, cacheHits: 0, baseline: null, elapsedMs: 0 });
      return;
    }
    prune();
    var dKey = decisionKey(analysis);
    if (fresh(decisions[dKey], decisionTtlMs)) {
      var hit = decisions[dKey];
      cb(null, {
        adGroupIndices: hit.adGroupIndices.slice(),
        probed: 0,
        failed: 0,
        cacheHits: groups.length,
        baseline: hit.baseline,
        decisionCached: true,
        elapsedMs: now() - started
      });
      return;
    }

    var deadline = started + budgetMs;
    probeAll(groups, deadline, function (results, budgetExceeded, encrypted) {
      var baseline = baselineOf(results);
      var probes = [];
      for (var p = 0; p < results.length; p++) {
        var r = results[p];
        probes.push({
          index: r.index,
          duration: r.duration,
          flagged: r.ok && deviates(r.dims, baseline)
        });
      }
      var indices = baseline ? adGroupIndices(probes) : [];
      if (baseline) {
        decisions[dKey] = { adGroupIndices: indices, baseline: baseline, at: now() };
      }
      var failed = 0;
      var cacheHits = 0;
      for (var q = 0; q < results.length; q++) {
        if (!results[q].ok) failed += 1;
        if (results[q].cached) cacheHits += 1;
      }
      cb(null, {
        adGroupIndices: indices,
        probed: results.length,
        failed: failed,
        cacheHits: cacheHits,
        unprobed: groups.length - results.length,
        baseline: baseline,
        encrypted: encrypted,
        budgetExceeded: budgetExceeded,
        elapsedMs: now() - started
      });
    });
  }

  return {
    classify: classify,
    // Measure one group's coded signature. Used by the source-resolution
    // read, which wants the stream's real resolution rather than a verdict.
    // Shares the segment and key caches with classify, so a source whose
    // playlist the proxy already classified is measured for free.
    measure: function (group, cb) {
      fetchKey(group.key, function (key) {
        probeGroup(group, key, function (res) {
          cb(null, { dims: res.dims, cached: res.cached, failure: res.failure || null });
        });
      });
    },
    clearCaches: function () {
      segments = {};
      keys = {};
      decisions = {};
    },
    cacheSizes: function () {
      return {
        segments: Object.keys(segments).length,
        keys: Object.keys(keys).length,
        decisions: Object.keys(decisions).length
      };
    }
  };
}

module.exports = {
  createSegmentProber: createSegmentProber,
  needsProbe: needsProbe,
  segmentKey: segmentKey,
  deviates: deviates,
  baselineOf: baselineOf,
  adGroupIndices: adGroupIndices,
  decisionKey: decisionKey,
  MIN_AD_RANGE_S: MIN_AD_RANGE_S,
  FIRST_PROBE_BYTES: FIRST_PROBE_BYTES,
  RETRY_PROBE_BYTES: RETRY_PROBE_BYTES
};
