// outroMark.js — pure timeline rules for per-title outro marks.

export const MIN_FROM_END_SECONDS = 1;
export const MAX_FROM_END_FRACTION = 0.5;

export function outroMarkKey(title, year) {
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

export function getOutroFromEnd(currentTime, duration) {
  const current = Number(currentTime);
  const dur = Number(duration);
  if (!Number.isFinite(current) || !Number.isFinite(dur)) return null;
  const fromEnd = dur - current;
  return isValidOutroMark({ fromEnd }, dur) ? fromEnd : null;
}

export function outroMarkerPercent(mark, duration) {
  const dur = Number(duration);
  if (!isValidOutroMark(mark, dur)) return null;
  return Math.max(0, Math.min(100, (1 - Number(mark.fromEnd) / dur) * 100));
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
