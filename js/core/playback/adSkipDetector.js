// adSkipDetector.js — skip mid-roll ads using pre-scanned timeline ranges.
//
// Primary path: adSkipScanner probes each discontinuity group's first TS for
// coded resolution, then this module seeks once to range.end when playback
// enters range.start. No +6s crawl.
//
// Fallback: if the scan found nothing (or failed), keep a lightweight live
// detector on videoWidth/videoHeight so sources that change resolution at the
// decoder still get some skip behaviour.

export const AREA_RATIO_MAX = 0.55;
export const DIM_RATIO_MAX = 0.80;
export const BASELINE_STABLE_SAMPLES = 4;
export const MIN_BASELINE_TIME_S = 3;
export const SKIP_STEP_S = 6;
export const MAX_SKIP_BURST_S = 120;
export const COOLDOWN_MS = 1500;
export const RECOVER_STABLE_SAMPLES = 2;
// Jump slightly before the ad starts so the first ad frame is less likely to paint.
export const RANGE_LEAD_S = 0.35;

export function initialAdSkipState() {
  return {
    // Pre-scan
    scanStatus: "idle", // idle | running | done | failed
    ranges: [], // { start, end }
    jumped: {}, // index -> true
    scanElapsedMs: 0,
    dynamicStitched: false, // source re-randomizes ad positions per request
    // Live fallback (only when ranges empty after scan settles)
    baselineW: 0,
    baselineH: 0,
    candidateW: 0,
    candidateH: 0,
    stableCount: 0,
    locked: false,
    skipping: false,
    skipOrigin: 0,
    matchBackCount: 0,
    cooldownUntil: 0,
    toasted: false
  };
}

function area(w, h) {
  return w * h;
}

export function isAdResolution(w, h, baselineW, baselineH) {
  if (!w || !h || !baselineW || !baselineH) return false;
  const baseArea = area(baselineW, baselineH);
  const curArea = area(w, h);
  if (curArea >= baseArea * 0.95) return false;
  if (curArea / baseArea > AREA_RATIO_MAX) return false;
  if (w > baselineW * DIM_RATIO_MAX || h > baselineH * DIM_RATIO_MAX) return false;
  return true;
}

/** Apply a completed scan result onto detector state. */
export function applyScanResult(state, result) {
  const next = { ...state };
  next.scanStatus = "done";
  next.scanElapsedMs = result?.elapsedMs || 0;
  next.ranges = Array.isArray(result?.ranges) ? result.ranges.slice() : [];
  next.jumped = {};
  next.dynamicStitched = Boolean(result?.dynamicStitched);
  if (result?.baseline?.w && result?.baseline?.h) {
    next.baselineW = result.baseline.w;
    next.baselineH = result.baseline.h;
    next.locked = true;
  }
  return next;
}

export function markScanRunning(state) {
  return { ...state, scanStatus: "running", ranges: [], jumped: {} };
}

export function markScanFailed(state) {
  return { ...state, scanStatus: "failed" };
}

/**
 * @returns {{
 *   state: ReturnType<typeof initialAdSkipState>,
 *   action: null | { type: "seek", to: number, toast?: string }
 * }}
 */
export function observeAdSkip(state, sample) {
  const next = { ...state };
  const { w, h, currentTime, duration, paused, seeking, ended, now } = sample;

  if (ended || paused) {
    if (next.skipping) {
      next.skipping = false;
      next.matchBackCount = 0;
      next.toasted = false;
    }
    return { state: next, action: null };
  }
  if (seeking) return { state: next, action: null };

  // --- Primary: pre-scanned ranges (one seek per range) ---
  if (next.ranges.length) {
    for (let i = 0; i < next.ranges.length; i++) {
      if (next.jumped[i]) continue;
      const range = next.ranges[i];
      const start = range.start - RANGE_LEAD_S;
      const end = range.end;
      if (currentTime >= start && currentTime < end - 0.4) {
        next.jumped = { ...next.jumped, [i]: true };
        const cap = Number.isFinite(duration) && duration > 0
          ? Math.max(0, duration - 0.5)
          : end;
        const to = Math.min(Math.max(end, currentTime + 0.5), cap);
        const skipped = Math.max(0, end - Math.max(currentTime, range.start));
        const toast = skipped >= 2
          ? `检测到广告，跳过 ${Math.round(skipped)} 秒`
          : "检测到广告，正在跳过";
        return { state: next, action: { type: "seek", to, toast } };
      }
    }
    // Ranges known — do not also run live crawl (avoids double-skip thrash).
    return { state: next, action: null };
  }

  // --- Fallback live detector (scan still running / failed / found nothing) ---
  if (!w || !h) return { state: next, action: null };

  if (!next.locked) {
    if (currentTime < MIN_BASELINE_TIME_S) return { state: next, action: null };
    if (w === next.candidateW && h === next.candidateH) next.stableCount += 1;
    else {
      next.candidateW = w;
      next.candidateH = h;
      next.stableCount = 1;
    }
    if (next.stableCount >= BASELINE_STABLE_SAMPLES) {
      next.baselineW = next.candidateW;
      next.baselineH = next.candidateH;
      next.locked = true;
    }
    return { state: next, action: null };
  }

  if (area(w, h) > area(next.baselineW, next.baselineH) * 1.05) {
    next.baselineW = w;
    next.baselineH = h;
    if (next.skipping) {
      next.skipping = false;
      next.matchBackCount = 0;
      next.toasted = false;
    }
    return { state: next, action: null };
  }

  if (now < next.cooldownUntil) return { state: next, action: null };

  const ad = isAdResolution(w, h, next.baselineW, next.baselineH);
  if (ad) {
    next.matchBackCount = 0;
    if (!next.skipping) {
      next.skipping = true;
      next.skipOrigin = currentTime;
      next.toasted = false;
    }
    if (currentTime - next.skipOrigin >= MAX_SKIP_BURST_S) {
      next.skipping = false;
      next.toasted = false;
      next.cooldownUntil = now + COOLDOWN_MS * 4;
      return { state: next, action: null };
    }
    const cap = Number.isFinite(duration) && duration > 0
      ? Math.max(0, duration - 0.5)
      : currentTime + SKIP_STEP_S;
    const to = Math.min(currentTime + SKIP_STEP_S, cap);
    if (to <= currentTime + 0.25) return { state: next, action: null };
    const toast = next.toasted ? undefined : "检测到广告，正在跳过";
    next.toasted = true;
    return { state: next, action: { type: "seek", to, toast } };
  }

  if (next.skipping) {
    next.matchBackCount += 1;
    if (next.matchBackCount >= RECOVER_STABLE_SAMPLES) {
      next.skipping = false;
      next.matchBackCount = 0;
      next.toasted = false;
      next.cooldownUntil = now + COOLDOWN_MS;
      const skipped = Math.max(0, currentTime - next.skipOrigin);
      const toast = skipped >= 3 ? `已跳过广告 ${Math.round(skipped)} 秒` : undefined;
      return {
        state: next,
        action: toast ? { type: "seek", to: currentTime, toast } : null
      };
    }
  }

  return { state: next, action: null };
}
