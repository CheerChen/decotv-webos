// probeLabel.js — shared presentation for playback probe results.

import {
  isPlayableFallbackResult,
  isVerifiedPlaybackResult,
} from "../core/network/sourceRanking.js";
import { escapeHtml } from "./utils.js";

export function probeLabel(result, {
  maxMessageLength = 28,
  pendingText = "未测速",
  missingPingText = "0 ms",
  partialText = "可播",
} = {}) {
  if (!result) {
    return { className: "probe-pending", symbol: "", text: pendingText };
  }
  if (result.hasError || result.status === "failed") {
    return {
      className: "probe-failed",
      symbol: "✕",
      text: String(result.message || "失败").slice(0, maxMessageLength),
    };
  }
  if (isVerifiedPlaybackResult(result)) {
    const speed = result.speedKBps
      ? `${(result.speedKBps / 1024).toFixed(2)} MB/s`
      : (result.loadSpeed || "—");
    const ping = result.pingTime ? `${result.pingTime} ms` : missingPingText;
    return {
      className: "probe-ok",
      symbol: "✓",
      text: `${result.quality || "—"} · ${speed} · ${ping}`,
    };
  }
  return {
    className: "probe-partial",
    symbol: "◐",
    text: String(result.message || partialText).slice(0, maxMessageLength),
    playable: isPlayableFallbackResult(result),
  };
}

export function renderProbeCell(result) {
  const label = probeLabel(result, {
    maxMessageLength: 24,
    pendingText: "待测速",
    missingPingText: "—",
    partialText: isPlayableFallbackResult(result) ? "可播" : "部分",
  });
  const prefix = label.symbol ? `${label.symbol} ` : "";
  return `<span class="${label.className}">${prefix}${escapeHtml(label.text)}</span>`;
}

export function renderProbeLine(result) {
  const label = probeLabel(result);
  const prefix = label.symbol ? `${label.symbol} ` : "";
  return `${prefix}${escapeHtml(label.text)}`;
}
