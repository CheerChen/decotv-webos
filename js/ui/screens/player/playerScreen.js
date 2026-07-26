// playerScreen.js — minimal video player with OSD + episode switcher.
// <video> plays HLS natively on webOS (UMS hardware decode). No HLS.js.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { showToast } from "../../../core/network/toast.js";

// How often playback progress is persisted to /api/playrecords while watching.
const RECORD_SAVE_INTERVAL_MS = 10000;
import {
  comparePlaybackMetrics,
  getSourceProbeKey,
  isPlayableFallbackResult,
  isVerifiedPlaybackResult
} from "../../../core/network/sourceRanking.js";

// Monochrome inline SVG glyphs (inherit button color via currentColor) —
// replaces the colored system emoji that rendered as ugly yellow icons.
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  // Skip back 30s (double left triangle)
  rewind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6 L5 12 L11 18 Z M18 6 L12 12 L18 18 Z"/></svg>',
  // Skip forward 30s (double right triangle)
  forward: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 6 L19 12 L13 18 Z M6 6 L12 12 L6 18 Z"/></svg>'
};

function formatTime(s) {
  const t = Math.max(0, Math.floor(Number(s || 0)));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export const PlayerScreen = {
  container: null,
  video: null,
  params: null,
  episodes: [],
  index: 0,
  paused: false,
  controlsVisible: true,
  controlsHideTimer: null,
  tickTimer: null,
  episodePanelVisible: false,
  episodePanelIndex: 0,
  sourcePanelVisible: false,
  sourcePanelIndex: 0,
  allSources: [],
  probeResults: new Map(),
  currentSourceKey: "",
  focusZone: "controls",
  _listeners: [],
  resumeTime: 0,          // seconds to seek to when the initial episode loads
  _resumeApplied: false,
  recordMeta: null,       // { source, id, title, cover, source_name, year, total_episodes }
  _lastSaveAt: 0,
  _isExiting: false,      // re-entrancy guard for stop+exit (back key / error / ended)

  async mount(params = {}) {
    this.container = document.getElementById("player");
    this.params = params;
    this.episodes = Array.isArray(params.episodes) ? params.episodes : [];
    this.index = Math.max(0, Math.min(params.index || 0, this.episodes.length - 1));
    this.paused = false;
    this.controlsVisible = true;
    this.episodePanelVisible = false;
    this.episodePanelIndex = this.index;
    this.sourcePanelVisible = false;
    this.sourcePanelIndex = 0;
    this.allSources = Array.isArray(params.allSources) ? params.allSources : [];
    this.probeResults = new Map(
      Array.isArray(params.probeResults) ? params.probeResults.map(([k, v]) => [k, v]) : []
    );
    this.currentSourceKey = params.currentSourceKey || "";
    this.focusZone = "controls";
    this._listeners = [];
    this.resumeTime = Math.max(0, Number(params.resumeTime || 0));
    this._resumeApplied = false;
    this.recordMeta = params.record || null;
    this._lastSaveAt = 0;
    this._isExiting = false;

    this.container.innerHTML = `
      <video id="videoPlayer" autoplay playsinline webkit-playsinline preload="auto"
        style="width:100vw;height:100vh;background:#000"></video>
      <div class="player-ui-root" id="playerUiRoot">
        <div class="player-loading-overlay" id="playerLoading"><div class="loading-spinner"></div></div>
        <div class="player-controls-overlay" id="playerControls">
          <div class="player-controls-top">
            <div class="player-meta">
              <div class="player-title" id="playerTitle"></div>
              <div class="player-subtitle" id="playerSubtitle"></div>
            </div>
          </div>
          <div class="player-controls-bottom">
            <div class="player-progress-track" id="playerProgress">
              <div class="player-progress-fill" id="playerProgressFill"></div>
              <div class="player-progress-thumb" id="playerProgressThumb"></div>
            </div>
            <div class="player-controls-row">
              <div class="player-control-buttons" id="playerButtons"></div>
              <div class="player-time-label" id="playerTime">0:00 / 0:00</div>
            </div>
          </div>
        </div>
      </div>
    `;
    this.video = this.container.querySelector("#videoPlayer");
    this.video.style.display = "block";

    ScreenUtils.show(this.container);
    this._renderButtons();
    this._bindVideo();
    this._playIndex(this.index);

    this.tickTimer = setInterval(() => this._tick(), 500);
    this._resetControlsAutoHide();
    ScreenUtils.setInitialFocus(this.container.querySelector('.player-control-btn[data-ctrl="playPause"]'));
  },

  _renderButtons() {
    const wrap = this.container.querySelector("#playerButtons");
    const defs = [
      { action: "playPause", label: this.paused ? ICONS.play : ICONS.pause },
      { action: "seekBack", label: ICONS.rewind },
      { action: "seekFwd", label: ICONS.forward },
      { action: "sourcePanel", label: "换源", text: true, active: this.sourcePanelVisible, disabled: this.allSources.length <= 1 },
      { action: "episodePanel", label: "列表", text: true, active: this.episodePanelVisible, disabled: this.episodes.length <= 1 },
      { action: "back", label: "返回", text: true }
    ];
    wrap.innerHTML = defs.map((d) => `
      <button class="player-control-btn${d.text ? " player-control-btn-text" : ""}${d.active ? " active" : ""}${d.disabled ? "" : " focusable"}"
        data-ctrl="${d.action}" ${d.disabled ? "disabled" : ""}>${d.label}</button>
    `).join("");
  },

  _bindVideo() {
    const v = this.video;
    const on = (ev, fn) => { v.addEventListener(ev, fn); this._listeners.push([ev, fn]); };
    on("loadstart", () => this.container.querySelector("#playerLoading")?.classList.remove("hidden"));
    on("canplay", () => {
      this.container.querySelector("#playerLoading")?.classList.add("hidden");
      this._applyResume();
    });
    on("loadedmetadata", () => this._applyResume());
    on("playing", () => {
      this.paused = false;
      this.container.querySelector("#playerLoading")?.classList.add("hidden");
      this._renderButtons();
    });
    on("pause", () => { this.paused = true; this._renderButtons(); this._saveRecord(true); });
    on("ended", () => this._handleEnded());
    on("error", () => {
      this.container.querySelector("#playerLoading")?.classList.add("hidden");
      showToast("播放错误，尝试下一集");
      this._advanceOrExit();
    });
  },

  _playIndex(idx) {
    if (idx < 0 || idx >= this.episodes.length) return;
    // Switching episodes (panel pick / auto-advance): persist the outgoing
    // episode first, then start the new one from the beginning (no resume).
    const switching = this._resumeApplied;
    if (switching) {
      this._saveRecord(true);
      this.resumeTime = 0;
      this._resumeApplied = false;
    }
    this.index = idx;
    this.episodePanelIndex = idx;
    const url = this.episodes[idx];
    this.container.querySelector("#playerLoading")?.classList.remove("hidden");
    this.video.src = url;
    this.video.load();
    const playPromise = this.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => { /* autoplay restriction — user must press play */ });
    }
    this._updateMeta();
  },

  _updateMeta() {
    const title = this.params?.title || "";
    const sourceName = this.params?.sourceName || "";
    const epLabel = this.episodes.length > 1 ? `第 ${this.index + 1} 集 / 共 ${this.episodes.length} 集` : "";
    const probeInfo = this._currentProbeInfo();
    this.container.querySelector("#playerTitle").textContent = title;
    this.container.querySelector("#playerSubtitle").textContent =
      [sourceName, epLabel, probeInfo].filter(Boolean).join(" · ");
  },

  // Build a short "1080p · 656ms" string from the current source's probe
  // result so the user can see what quality/latency the active stream has.
  _currentProbeInfo() {
    if (!this.currentSourceKey || !this.probeResults) return "";
    const r = this.probeResults.get(this.currentSourceKey);
    if (!r || r.hasError) return "";
    const q = r.quality && r.quality !== "未知" ? r.quality : "";
    const ping = r.pingTime ? `${r.pingTime}ms` : "";
    return [q, ping].filter(Boolean).join(" · ");
  },

  _tick() {
    const v = this.video;
    if (!v) return;
    const cur = v.currentTime || 0;
    const dur = v.duration || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    this.container.querySelector("#playerProgressFill").style.width = `${pct}%`;
    this.container.querySelector("#playerProgressThumb").style.left = `${pct}%`;
    this.container.querySelector("#playerTime").textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    if (!this._resumeApplied) this._applyResume(); // retry until metadata is ready
    // Persist progress periodically while actually playing.
    if (!v.paused && cur > 0) {
      const now = Date.now();
      if (now - this._lastSaveAt >= RECORD_SAVE_INTERVAL_MS) this._saveRecord();
    }
  },

  // Seek to the resume position once, when the initial episode's duration is
  // known. If metadata is not ready yet, leave it unapplied so a later
  // canplay / loadedmetadata / tick retries.
  _applyResume() {
    if (this._resumeApplied || !this.video) return;
    if (this.resumeTime <= 0) { this._resumeApplied = true; return; }
    const dur = this.video.duration || 0;
    if (!dur || !Number.isFinite(dur)) return;
    // Don't resume within the final 10s (treat as finished → start over).
    if (this.resumeTime < dur - 10) {
      try { this.video.currentTime = this.resumeTime; } catch (_) {}
      showToast(`已从 ${formatTime(this.resumeTime)} 继续播放`);
    }
    this._resumeApplied = true;
  },

  // Persist play progress on-device (see localLibrary.js).
  _saveRecord(force = false) {
    const v = this.video;
    if (!v || !this.recordMeta) return;
    const m = this.recordMeta;
    if (!m.title) return;
    const cur = Math.floor(v.currentTime || 0);
    const dur = Math.floor(v.duration || 0);
    if (!force && cur <= 0) return;
    this._lastSaveAt = Date.now();
    // Keyed per-movie (title|year), not per-source: switching sources via the
    // 3-pick algorithm overwrites the same record so "continue watching"
    // always resumes by title regardless of which source was used.
    const key = LocalLibrary.recordKeyForTitle(m.title, m.year);
    // index is 1-based (episode number), matching the DecoTV record convention.
    LocalLibrary.savePlayRecord(key, {
      title: m.title,
      cover: m.cover || "",
      source_name: m.source_name || m.source,
      year: m.year || "",
      index: this.index + 1,
      total_episodes: m.total_episodes || this.episodes.length,
      play_time: cur,
      total_time: dur
    });
  },

  _handleEnded() {
    this._advanceOrExit();
  },

  _advanceOrExit() {
    if (this.index + 1 < this.episodes.length) {
      this._playIndex(this.index + 1);
    } else {
      // last episode finished or source failed → back to detail.
      // _stopAndExit is idempotent (guards against a burst of error events),
      // then Router.back() pops the stack. Router.back() will call
      // consumeBackRequest() again, but _isExiting is already true so
      // _stopAndExit is a no-op and consumeBackRequest returns false,
      // letting back() proceed to pop the stack.
      this._stopAndExit();
      Router.back();
    }
  },

  setControlsVisible(visible) {
    this.controlsVisible = visible;
    const overlay = this.container.querySelector("#playerControls");
    if (!overlay) return;
    if (visible) overlay.classList.remove("hidden");
    else overlay.classList.add("hidden");
    if (visible) this._resetControlsAutoHide();
  },

  _resetControlsAutoHide() {
    if (this.controlsHideTimer) clearTimeout(this.controlsHideTimer);
    this.controlsHideTimer = setTimeout(() => {
      // Auto-hide only when playing and no panel open.
      if (!this.paused && !this.episodePanelVisible && !this.sourcePanelVisible) this.setControlsVisible(false);
    }, 5000);
  },

  _togglePlayPause() {
    if (!this.video) return;
    if (this.video.paused) this.video.play();
    else this.video.pause();
    this.setControlsVisible(true);
  },

  _seek(delta) {
    if (!this.video || !this.video.duration) return;
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, this.video.currentTime + delta));
    this.setControlsVisible(true);
  },

  _toggleSourcePanel() {
    if (this.allSources.length <= 1) return;
    this.sourcePanelVisible = !this.sourcePanelVisible;
    if (this.sourcePanelVisible) {
      // Default focus to the currently playing source.
      this.sourcePanelIndex = Math.max(0, this.allSources.findIndex(
        (s) => getSourceProbeKey(s) === this.currentSourceKey
      ));
      this._renderSourcePanel();
    } else {
      this.container.querySelector("#playerSourcePanel")?.remove();
    }
    this._renderButtons();
    this._resetControlsAutoHide();
  },

  _renderSourcePanel() {
    this.container.querySelector("#playerSourcePanel")?.remove();
    // Sort sources by probe result (best first), unprobed at end.
    const ranked = [...this.allSources].sort((a, b) => {
      const ra = this.probeResults.get(getSourceProbeKey(a));
      const rb = this.probeResults.get(getSourceProbeKey(b));
      if (!ra && !rb) return 0;
      if (!ra) return 1;
      if (!rb) return -1;
      return comparePlaybackMetrics(ra, rb);
    });
    const panel = document.createElement("div");
    panel.id = "playerSourcePanel";
    panel.className = "player-side-panel";
    panel.innerHTML = `
      <div class="player-side-panel-header">
        <div class="player-side-panel-title">播放源</div>
        <button class="player-side-panel-close focusable" data-panel-close="1">关闭</button>
      </div>
      <div class="player-side-panel-hint">▲▼ 选择 · OK 切换并重播 · 返回 关闭</div>
      <div class="player-side-panel-list" id="playerSourceList">
        ${ranked.map((src, i) => {
          const key = getSourceProbeKey(src);
          const r = this.probeResults.get(key);
          const isCurrent = key === this.currentSourceKey;
          const probeLine = this._probeLineHtml(r);
          return `
            <div class="player-side-item${isCurrent ? " selected" : ""} focusable" data-panel-source-key="${this._escapeAttr(key)}" data-panel-index="${i}">
              <div class="player-side-item-label">${this._escape(src.source_name || src.source)}${isCurrent ? " · 正在播放" : ""}</div>
              <div class="player-side-item-sub">${probeLine}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
    this.container.appendChild(panel);
    ScreenUtils.indexFocusables(panel, ".focusable");
    const target = panel.querySelector(`[data-panel-source-key="${this._escapeAttr(getSourceProbeKey(this.allSources[this.sourcePanelIndex] || this.allSources[0]))}"]`)
      || panel.querySelector(".player-side-item");
    if (target) {
      panel.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      target.classList.add("focused");
      target.focus();
      target.scrollIntoView?.({ block: "center" });
    }
  },

  _probeLineHtml(r) {
    if (!r) return "未测速";
    if (r.hasError || r.status === "failed") return `✕ ${this._escape((r.message || "失败").slice(0, 28))}`;
    if (isVerifiedPlaybackResult(r)) {
      const speed = r.speedKBps ? `${(r.speedKBps / 1024).toFixed(2)} MB/s` : (r.loadSpeed || "—");
      return `✓ ${this._escape(r.quality || "—")} · ${this._escape(speed)} · ${r.pingTime || 0} ms`;
    }
    return `◐ ${this._escape((r.message || "可播").slice(0, 28))}`;
  },

  _closeSourcePanel() {
    this.sourcePanelVisible = false;
    this.container.querySelector("#playerSourcePanel")?.remove();
    this._renderButtons();
    const btn = this.container.querySelector('.player-control-btn[data-ctrl="sourcePanel"]');
    if (btn) {
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      btn.classList.add("focused");
      btn.focus();
    }
    this._resetControlsAutoHide();
  },

  _switchToSourceKey(key) {
    const src = this.allSources.find((s) => getSourceProbeKey(s) === key);
    if (!src) return;
    if (key === this.currentSourceKey) { this._closeSourcePanel(); return; }
    // Swap episodes + current key, replay same episode index (clamped).
    const newEpisodes = Array.isArray(src.episodes) ? src.episodes : [];
    if (!newEpisodes.length) { showToast("该源无剧集"); return; }
    // Persist the outgoing source's progress before re-pointing metadata.
    this._saveRecord(true);
    this.episodes = newEpisodes;
    this.currentSourceKey = key;
    this.params = { ...this.params, title: src.title || this.params?.title, sourceName: src.source_name || src.source };
    // Record key is per-movie (title|year), so switching sources does NOT
    // change the key — the new source's progress overwrites the same record.
    if (this.recordMeta) {
      this.recordMeta = {
        ...this.recordMeta,
        source: src.source,
        id: src.id,
        source_name: src.source_name || src.source,
        title: src.title || this.recordMeta.title,
        cover: src.poster || this.recordMeta.cover,
        year: src.year || this.recordMeta.year,
        total_episodes: newEpisodes.length
      };
    }
    const newIndex = Math.min(this.index, newEpisodes.length - 1);
    this.index = newIndex;
    // Outgoing source already saved above; start the new source cleanly at 0.
    this.resumeTime = 0;
    this._resumeApplied = false;
    this._closeSourcePanel();
    this._playIndex(newIndex);
    this._updateMeta();
    showToast(`已切换到「${src.source_name || src.source}」`);
  },

  _toggleEpisodePanel() {
    if (this.episodes.length <= 1) return;
    this.episodePanelVisible = !this.episodePanelVisible;
    if (this.episodePanelVisible) {
      this.episodePanelIndex = this.index;
      this._renderEpisodePanel();
    } else {
      this.container.querySelector("#playerEpisodePanel")?.remove();
    }
    this._renderButtons();
    this._resetControlsAutoHide();
  },

  _renderEpisodePanel() {
    this.container.querySelector("#playerEpisodePanel")?.remove();
    const panel = document.createElement("div");
    panel.id = "playerEpisodePanel";
    panel.className = "player-side-panel";
    const items = this.episodes.map((_, i) => ({
      label: `第 ${i + 1} 集`,
      sub: i === this.index ? "正在播放" : ""
    }));
    panel.innerHTML = `
      <div class="player-side-panel-header">
        <div class="player-side-panel-title">剧集列表</div>
        <button class="player-side-panel-close focusable" data-panel-close="1">关闭</button>
      </div>
      <div class="player-side-panel-hint">▲▼ 选择 · OK 播放 · 返回 关闭</div>
      <div class="player-side-panel-list" id="playerEpisodeList">
        ${items.map((it, i) => `
          <div class="player-side-item${i === this.episodePanelIndex ? " selected" : ""} focusable" data-panel-index="${i}">
            <div class="player-side-item-label">${it.label}</div>
            ${it.sub ? `<div class="player-side-item-sub">${it.sub}</div>` : ""}
          </div>
        `).join("")}
      </div>
    `;
    this.container.appendChild(panel);
    ScreenUtils.indexFocusables(panel);
    const selected = panel.querySelector(`[data-panel-index="${this.episodePanelIndex}"]`);
    if (selected) {
      panel.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      selected.classList.add("focused");
      selected.focus();
      selected.scrollIntoView?.({ block: "center" });
    }
  },

  _closeEpisodePanel() {
    this.episodePanelVisible = false;
    this.container.querySelector("#playerEpisodePanel")?.remove();
    this._renderButtons();
    const btn = this.container.querySelector('.player-control-btn[data-ctrl="episodePanel"]');
    if (btn) {
      this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
      btn.classList.add("focused");
      btn.focus();
    }
    this._resetControlsAutoHide();
  },

  async onKeyDown(event) {
    const code = Number(event.keyCode || 0);

    // Source panel takes over navigation when visible.
    if (this.sourcePanelVisible) {
      const panel = this.container.querySelector("#playerSourcePanel");
      if (code === 37 || code === 39) {
        const dir = code === 37 ? "up" : "down";
        ScreenUtils.moveFocusDirectional(panel, dir, ".focusable");
        return;
      }
      if (ScreenUtils.handleDpadNavigation(event, panel, ".focusable")) return;
      if (code === 13) {
        const focused = panel.querySelector(".focused");
        if (focused?.dataset?.panelClose) { this._closeSourcePanel(); return; }
        if (focused?.dataset?.panelSourceKey) {
          this._switchToSourceKey(focused.dataset.panelSourceKey);
          return;
        }
        return;
      }
      if (code === 461 || code === 27 || code === 8) {
        this._closeSourcePanel();
        return;
      }
      return;
    }

    // Episode panel takes over navigation when visible.
    if (this.episodePanelVisible) {
      const panel = this.container.querySelector("#playerEpisodePanel");
      if (code === 37 || code === 39) {
        // left/right inside panel: re-map to up/down for vertical list
        const dir = code === 37 ? "up" : "down";
        ScreenUtils.moveFocusDirectional(panel, dir, ".focusable");
        return;
      }
      if (ScreenUtils.handleDpadNavigation(event, panel, ".focusable")) return;
      if (code === 13) {
        const focused = panel.querySelector(".focused");
        if (focused?.dataset?.panelClose) { this._closeEpisodePanel(); return; }
        if (focused?.dataset?.panelIndex !== undefined) {
          const idx = Number(focused.dataset.panelIndex);
          this._playIndex(idx);
          this._closeEpisodePanel();
          return;
        }
        return;
      }
      // Back (461/27/8) → close panel
      if (code === 461 || code === 27 || code === 8) {
        this._closeEpisodePanel();
        return;
      }
      return;
    }

    // No panel: controls area vs button area navigation.
    const focusedBtn = this.container.querySelector(".player-control-btn.focused");

    // Down → move focus to control buttons (show controls if hidden).
    if (code === 40) {
      if (!this.controlsVisible) { this.setControlsVisible(true); return; }
      if (!focusedBtn) {
        const first = this.container.querySelector('.player-control-btn[data-ctrl="playPause"]');
        if (first) {
          this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
          first.classList.add("focused");
          first.focus();
        }
      }
      this._resetControlsAutoHide();
      return;
    }

    // Up → if on buttons, go back to video area (unfocus). Otherwise seek +30.
    if (code === 38) {
      if (focusedBtn) {
        focusedBtn.classList.remove("focused");
        this._resetControlsAutoHide();
        return;
      }
      this._seek(30);
      return;
    }

    // Left/Right: if on buttons, move between them. Otherwise seek.
    if (code === 37 || code === 39) {
      if (focusedBtn) {
        ScreenUtils.moveFocusDirectional(this.container, code === 37 ? "left" : "right", ".player-control-btn");
        this._resetControlsAutoHide();
        return;
      }
      this._seek(code === 37 ? -10 : 10);
      return;
    }

    if (code === 13) {
      if (focusedBtn) { this._performControlAction(focusedBtn.dataset.ctrl); return; }
      // No focused control: toggle play/pause + show controls.
      this._togglePlayPause();
      return;
    }
    if (code === 32) { this._togglePlayPause(); return; } // space (dev)
    if (code === 461 || code === 27 || code === 8) {
      this._stopAndExit();
      return;
    }
  },

  _performControlAction(action) {
    switch (action) {
      case "playPause": this._togglePlayPause(); break;
      case "seekBack": this._seek(-30); break;
      case "seekFwd": this._seek(30); break;
      case "sourcePanel": this._toggleSourcePanel(); break;
      case "episodePanel": this._toggleEpisodePanel(); break;
      case "back": this._stopAndExit(); break;
    }
  },

  consumeBackRequest() {
    if (this.sourcePanelVisible) {
      this._closeSourcePanel();
      return true;
    }
    if (this.episodePanelVisible) {
      this._closeEpisodePanel();
      return true;
    }
    // No panel open: tear down playback state, then return false so Router.back()
    // proceeds to pop the stack and navigate to detail. We must NOT call
    // Router.back() here — Router.back() calls consumeBackRequest() first,
    // so calling back() from inside consumeBackRequest() deadlocks (back()
    // returns early because consumeBackRequest returned true, and the stack
    // is never popped). The _isExiting guard makes this idempotent across
    // the FocusEngine → Router.back → popstate convergence.
    this._stopAndExit();
    return false;
  },

  // Tear down playback state (pause, persist progress, fade out). Does NOT
  // navigate — the caller (consumeBackRequest returning false, or
  // _advanceOrExit) is responsible for letting Router.back() pop the stack.
  // Idempotent via _isExiting.
  _stopAndExit() {
    if (this._isExiting) return;
    this._isExiting = true;
    try { this.video?.pause(); } catch (_) {}
    this._saveRecord(true);
    if (this.container) {
      this.container.style.transition = "opacity 200ms ease";
      this.container.style.opacity = "0";
    }
  },

  cleanup() {
    // Persist final position before tearing the video down.
    this._saveRecord(true);
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.controlsHideTimer) { clearTimeout(this.controlsHideTimer); this.controlsHideTimer = null; }
    if (this.video) {
      this._listeners.forEach(([ev, fn]) => this.video.removeEventListener(ev, fn));
      this._listeners = [];
      try { this.video.pause(); } catch (_) {}
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.container?.querySelector("#playerSourcePanel")?.remove();
    this.container?.querySelector("#playerEpisodePanel")?.remove();
    ScreenUtils.hide(this.container);
    if (this.container) this.container.style.opacity = "1";
  },

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  // Attribute-safe escape: also neutralizes backtick and quotes used in template literals.
  _escapeAttr(s) {
    return String(s ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
  }
};
