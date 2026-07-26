// toast.js — simple transient notification.

let toastTimer = null;

export function showToast(message, durationMs = 2400) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), durationMs);
}
