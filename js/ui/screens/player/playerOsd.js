// playerOsd.js — player controls, progress display, and focus state.

import { ScreenUtils } from "../../navigation/screen.js";
import { formatTime, escapeHtml } from "../../utils.js";
import { outroMarkerPercent } from "../../../core/playback/outroMark.js";
import { episodeLabel, hasVersionLabels } from "../../../core/network/sourceRanking.js";

const SCRUB_HOLD_MS = 350;
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  prevEp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h2v14H5zM18 6l-9 6 9 6z"/></svg>',
  nextEp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l9 6-9 6zM17 5h2v14h-2z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true" class="ad-shield-icon"><path d="M12 2L4 5v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V5l-8-3z" fill="currentColor"/><path d="M9.5 12.5l1.8 1.8 3.2-3.2" stroke="#1a1a2e" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export class PlayerOsd {
  constructor({
    container,
    getVideo,
    getTitle,
    getSourceName,
    getEpisodes,
    getIndex,
    getAllSources,
    getCurrentSource,
    getFilteredAdCount,
    getIsProxied,
    getPaused,
    getOutroMark,
    getEpisodePanelVisible,
    getSourcePanelVisible,
    onPanelsHidden,
  }) {
    this.container = container;
    this.getVideo = getVideo;
    this.getTitle = getTitle;
    this.getSourceName = getSourceName;
    this.getEpisodes = getEpisodes;
    this.getIndex = getIndex;
    this.getAllSources = getAllSources;
    this.getCurrentSource = getCurrentSource;
    this.getFilteredAdCount = getFilteredAdCount;
    this.getIsProxied = getIsProxied;
    this.getPaused = getPaused;
    this.getOutroMark = getOutroMark;
    this.getEpisodePanelVisible = getEpisodePanelVisible;
    this.getSourcePanelVisible = getSourcePanelVisible;
    this.onPanelsHidden = onPanelsHidden;
    this.controlsVisible = true;
    this.controlsHideTimer = null;
    this.focusZone = "progress";
    this.scrub = { pressed: false, active: false, dir: 0, holdTimer: 0, raf: 0, previewSec: 0, ts: 0, last: 0 };
  }

  renderButtons() {
    const wrap = this.container.querySelector("#playerButtons");
    if (!wrap) return;
    const episodes = this.getEpisodes() || [];
    const index = this.getIndex();
    const allSources = this.getAllSources() || [];
    const defs = [
      { action: "prevEp", label: ICONS.prevEp, disabled: episodes.length <= 1 || index <= 0 },
      { action: "playPause", label: this.getPaused() ? ICONS.play : ICONS.pause },
      { action: "nextEp", label: ICONS.nextEp, disabled: episodes.length <= 1 || index >= episodes.length - 1 },
      { action: "restart", label: ICONS.restart },
      { action: "episodePanel", label: "列表", text: true, active: this.getEpisodePanelVisible(), disabled: episodes.length <= 1 },
      { action: "sourcePanel", label: "换源", text: true, active: this.getSourcePanelVisible(), disabled: allSources.length <= 1 },
      { action: "markOutro", label: "标记片尾", text: true, disabled: episodes.length <= 1 },
    ];
    const focusedCtrl = wrap.querySelector(".player-control-btn.focused")?.dataset?.ctrl || null;
    wrap.innerHTML = defs.map((d) => `
      <button class="player-control-btn${d.text ? " player-control-btn-text" : ""}${d.active ? " active" : ""}${d.disabled ? "" : " focusable"}"
        data-ctrl="${d.action}" ${d.disabled ? "disabled" : ""}>${d.label}</button>
    `).join("");
    if (this.focusZone === "buttons") {
      const target = wrap.querySelector(`.player-control-btn.focusable[data-ctrl="${focusedCtrl}"]`)
        || wrap.querySelector('.player-control-btn[data-ctrl="playPause"]');
      if (target) ScreenUtils.setFocus(target, wrap);
    }
  }

  updateMeta() {
    const episodes = this.getEpisodes() || [];
    const index = this.getIndex();
    const title = this.getTitle() || "";
    const sourceName = this.getSourceName() || "";
    const src = this.getCurrentSource ? this.getCurrentSource() || {} : {};
    const isVersions = hasVersionLabels(src);
    const countWord = isVersions ? "版本" : "集";
    const epLabel = episodes.length > 1
      ? `${episodeLabel(src, index)} / 共 ${episodes.length} ${countWord}`
      : "";
    const adCount = this.getFilteredAdCount ? this.getFilteredAdCount() : 0;
    const isProxied = this.getIsProxied ? this.getIsProxied() : false;
    const subtitleParts = [sourceName, epLabel].filter(Boolean);
    let subtitleHtml = escapeHtml(subtitleParts.join(" · "));
    if (isProxied) {
      const countHtml = adCount > 0 ? `<span class="ad-filter-count">${adCount}</span>` : "";
      subtitleHtml += ` <span class="ad-filter-badge">${ICONS.shield}${countHtml}</span>`;
    }
    this.container.querySelector("#playerTitle").textContent = title;
    this.container.querySelector("#playerSubtitle").innerHTML = subtitleHtml;
    this.updateStats();
  }

  updateStats() {
    const el = this.container.querySelector("#playerOsdStats");
    if (!el) return;
    const video = this.getVideo();
    const parts = [];
    if (video && video.videoWidth && video.videoHeight) {
      parts.push(`${video.videoWidth}×${video.videoHeight}`);
    }
    if (video && video.buffered && video.buffered.length > 0) {
      const current = video.currentTime || 0;
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= current && video.buffered.end(i) >= current) {
          const bufferSeconds = video.buffered.end(i) - current;
          if (bufferSeconds > 0) parts.push(`缓冲 ${bufferSeconds.toFixed(0)}s`);
          break;
        }
      }
    }
    el.textContent = parts.join(" · ");
  }

  renderProgress(current, duration) {
    const pct = duration > 0 ? (current / duration) * 100 : 0;
    this.container.querySelector("#playerProgressFill").style.width = `${pct}%`;
    this.container.querySelector("#playerProgressThumb").style.left = `${pct}%`;
    this.container.querySelector("#playerTime").textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    const bubble = this.container.querySelector("#playerProgressBubble");
    if (bubble) {
      bubble.style.left = `${pct}%`;
      bubble.textContent = formatTime(current);
    }
  }

  updateOutroMarker(video) {
    const el = this.container.querySelector("#playerProgressOutro");
    if (!el) return;
    const episodes = this.getEpisodes() || [];
    const pct = episodes.length <= 1
      ? null
      : outroMarkerPercent(this.getOutroMark(), video?.duration);
    if (pct === null) {
      el.style.display = "none";
      return;
    }
    el.style.left = `${pct}%`;
    el.style.display = "block";
  }

  setVisible(visible) {
    const wasVisible = this.controlsVisible;
    this.controlsVisible = visible;
    const overlay = this.container.querySelector("#playerControls");
    if (!overlay) return;
    if (visible) {
      overlay.classList.remove("hidden");
      if (!wasVisible) this.focusProgress();
      this.resetAutoHide();
    } else {
      this.stopScrub?.(true);
      overlay.classList.add("hidden");
      overlay.querySelectorAll(".focused").forEach((node) => node.classList.remove("focused"));
      this.focusZone = "progress";
    }
  }

  resetAutoHide() {
    if (this.controlsHideTimer) clearTimeout(this.controlsHideTimer);
    this.controlsHideTimer = setTimeout(() => {
      this.controlsHideTimer = null;
      if (this.getPaused() || this.scrub.active) return;
      const hadPanel = this.getEpisodePanelVisible() || this.getSourcePanelVisible();
      if (hadPanel) this.onPanelsHidden?.();
      this.setVisible(false);
    }, 5000);
  }

  focusDefaultButton() {
    const first = this.container.querySelector('.player-control-btn[data-ctrl="playPause"]');
    if (first) ScreenUtils.setFocus(first, this.container);
  }

  focusProgress() {
    this.focusZone = "progress";
    const progress = this.container.querySelector("#playerProgress");
    if (progress) ScreenUtils.setFocus(progress, this.container);
  }

  focusButtons() {
    this.focusZone = "buttons";
    this.container.querySelector("#playerProgress")?.classList.remove("focused");
    this.focusDefaultButton();
  }

  scrubKeyDown(dir) {
    const scrub = this.scrub;
    if (scrub.pressed) {
      if (!scrub.active && scrub.dir === dir && !scrub.holdTimer) this.startScrub(dir);
      return;
    }
    scrub.pressed = true;
    scrub.dir = dir;
    if (scrub.holdTimer) clearTimeout(scrub.holdTimer);
    scrub.holdTimer = setTimeout(() => {
      scrub.holdTimer = 0;
      this.startScrub(dir);
    }, SCRUB_HOLD_MS);
  }

  startScrub(dir) {
    const video = this.getVideo();
    if (!video || !(video.duration > 0)) return;
    const scrub = this.scrub;
    scrub.active = true;
    scrub.dir = dir;
    scrub.previewSec = video.currentTime || 0;
    scrub.ts = performance.now();
    scrub.last = 0;
    this.container.querySelector("#playerProgress")?.classList.add("scrubbing");
    if (!scrub.raf) scrub.raf = requestAnimationFrame((now) => this.scrubTick(now));
  }

  scrubTick(now) {
    const scrub = this.scrub;
    const video = this.getVideo();
    if (!scrub.active) {
      scrub.raf = 0;
      return;
    }
    if (!video || !(video.duration > 0)) {
      this.stopScrub(false);
      return;
    }
    const last = scrub.last || now;
    scrub.last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    const held = (now - scrub.ts) / 1000;
    const speed = 8 + Math.min(held, 4) * 22;
    scrub.previewSec = Math.max(0, Math.min(video.duration, scrub.previewSec + scrub.dir * speed * dt));
    this.renderProgress(scrub.previewSec, video.duration);
    scrub.raf = requestAnimationFrame((next) => this.scrubTick(next));
  }

  stopScrub(commit) {
    const scrub = this.scrub;
    if (scrub.holdTimer) {
      clearTimeout(scrub.holdTimer);
      scrub.holdTimer = 0;
    }
    if (!scrub.active) return;
    scrub.active = false;
    scrub.last = 0;
    if (scrub.raf) {
      cancelAnimationFrame(scrub.raf);
      scrub.raf = 0;
    }
    this.container.querySelector("#playerProgress")?.classList.remove("scrubbing");
    const video = this.getVideo();
    if (commit && video && video.duration > 0) {
      try { video.currentTime = scrub.previewSec; } catch (_) {}
    }
    this.resetAutoHide();
  }

  onKeyUp(event) {
    const code = Number(event?.keyCode || 0);
    if (code !== 37 && code !== 39) return;
    const scrub = this.scrub;
    if (!scrub.pressed) return;
    if (scrub.holdTimer) {
      clearTimeout(scrub.holdTimer);
      scrub.holdTimer = 0;
    }
    if (scrub.active) this.stopScrub(true);
    else this.seek(scrub.dir * 10);
    scrub.pressed = false;
  }

  togglePlayPause() {
    const video = this.getVideo();
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
    this.setVisible(true);
  }

  seek(delta) {
    const video = this.getVideo();
    if (!video || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
    this.setVisible(true);
  }

  cleanup() {
    this.stopScrub(false);
    this.scrub.pressed = false;
    if (this.controlsHideTimer) {
      clearTimeout(this.controlsHideTimer);
      this.controlsHideTimer = null;
    }
  }
}
