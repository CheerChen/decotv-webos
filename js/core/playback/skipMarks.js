// skipMarks.js — pure timeline rules for per-title intro and outro marks.
//
// One mark record per title: { introEnd?, fromEnd? }. The intro mark is a
// position from the start (every episode starts there); the outro mark is a
// distance from the end (every episode but the last advances there). Each
// lives in its own half of the timeline, which is also how the single mark
// button decides what it does.

export const MIN_FROM_END_SECONDS = 1;
export const MIN_FROM_START_SECONDS = 1;
export const MAX_FROM_END_FRACTION = 0.5;
export const MAX_FROM_START_FRACTION = 0.5;

export function skipMarkKey(title, year) {
  const t = String(title || "").trim();
  const y = String(year || "").trim();
  if (!t) return "";
  return y ? `${t}|${y}` : t;
}

export function isValidOutroMark(mark, duration) {
  const fromEnd = Number(mark?.fromEnd);
  const dur = Number(duration);
  return Number.isFinite(fromEnd)
    && fromEnd >= MIN_FROM_END_SECONDS
    && Number.isFinite(dur)
    && dur > 0
    && fromEnd <= dur * MAX_FROM_END_FRACTION;
}

export function isValidIntroMark(mark, duration) {
  const introEnd = Number(mark?.introEnd);
  const dur = Number(duration);
  return Number.isFinite(introEnd)
    && introEnd >= MIN_FROM_START_SECONDS
    && Number.isFinite(dur)
    && dur > 0
    && introEnd <= dur * MAX_FROM_START_FRACTION;
}

export function getOutroFromEnd(currentTime, duration) {
  const current = Number(currentTime);
  const dur = Number(duration);
  if (!Number.isFinite(current) || !Number.isFinite(dur)) return null;
  const fromEnd = dur - current;
  return isValidOutroMark({ fromEnd }, dur) ? fromEnd : null;
}

export function getIntroEnd(currentTime, duration) {
  const introEnd = Number(currentTime);
  if (!Number.isFinite(introEnd)) return null;
  return isValidIntroMark({ introEnd }, duration) ? introEnd : null;
}

export function outroMarkerPercent(mark, duration) {
  const dur = Number(duration);
  if (!isValidOutroMark(mark, dur)) return null;
  return Math.max(0, Math.min(100, (1 - Number(mark.fromEnd) / dur) * 100));
}

export function introMarkerPercent(mark, duration) {
  const dur = Number(duration);
  if (!isValidIntroMark(mark, dur)) return null;
  return Math.max(0, Math.min(100, (Number(mark.introEnd) / dur) * 100));
}

// What the mark button does at this position. The first half of the
// timeline belongs to the intro, the second half to the outro. A half with
// no valid mark is marked here; a half that already holds one clears BOTH
// marks — so once both are set, one press anywhere clears them, and the
// outro no longer has to be reached (auto-advance fired there) to clear it.
// Unknown duration (metadata not loaded) counts as the intro half.
export function markButtonAction(mark, currentTime, duration) {
  const dur = Number(duration);
  const cur = Number(currentTime);
  const known = Number.isFinite(dur) && dur > 0 && Number.isFinite(cur);
  const half = known && cur >= dur * MAX_FROM_END_FRACTION ? "outro" : "intro";
  const marked = half === "intro" ? isValidIntroMark(mark, dur) : isValidOutroMark(mark, dur);
  return { half, marked };
}

export function shouldTriggerOutro({
  episodesLength,
  index,
  paused,
  seeking,
  ended,
  currentTime,
  duration,
  mark,
  isExiting = false,
  outroTriggered = false,
} = {}) {
  if (isExiting || outroTriggered) return false;
  if (Number(episodesLength) <= 1 || Number(index) >= Number(episodesLength) - 1) return false;
  if (paused || seeking || ended) return false;
  if (!Number.isFinite(Number(currentTime)) || !isValidOutroMark(mark, duration)) return false;
  return Number(currentTime) >= Number(duration) - Number(mark.fromEnd);
}

// Every episode, the first and the last included, starts past the intro.
// Decided once per load, after the resume seek: a resumed position already
// past the intro stays, and seeking back into the intro later is allowed.
export function shouldSkipIntro({
  episodesLength,
  currentTime,
  duration,
  mark,
  isExiting = false,
} = {}) {
  if (isExiting) return false;
  if (Number(episodesLength) <= 1) return false;
  if (!Number.isFinite(Number(currentTime)) || !isValidIntroMark(mark, duration)) return false;
  return Number(currentTime) < Number(mark.introEnd);
}
