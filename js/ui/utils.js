// utils.js — shared utility functions extracted from screen duplicates.

// Escape HTML text content (prevents XSS in innerHTML templates).
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Escape for HTML attributes (also neutralizes backtick for template literals).
export function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"'`]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;",
  }[c]));
}

// Format a rating/vote count for card sub-lines. The count is floored to
// two significant digits — the number only qualifies the score, so false
// precision is noise; "+" marks a count that was floored (never overstated).
// k/M units: 6421 → "6.4k+", 24310 → "24k+", 3247891 → "3.2M+".
// Empty string for 0/invalid so callers can omit the segment entirely.
export function formatVotes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  const mag = Math.floor(Math.log10(v));
  const step = Math.pow(10, Math.max(0, mag - 1));
  const floored = Math.floor(v / step) * step;
  const plus = floored < v ? "+" : "";
  // Two-significant-digit quotients are 1.0–9.9 (<1000) or integers.
  const fmt = (x) => (x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
  if (floored >= 1e6) return `${fmt(floored / 1e6)}M${plus}`;
  if (floored >= 1e3) return `${fmt(floored / 1e3)}k${plus}`;
  return `${floored}${plus}`;
}

// Format seconds as m:ss or h:mm:ss.
export function formatTime(s) {
  const t = Math.max(0, Math.floor(Number(s || 0)));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
