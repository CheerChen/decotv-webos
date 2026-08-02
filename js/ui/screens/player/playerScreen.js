// playerScreen.js — minimal video player with OSD + episode switcher.
// <video> plays HLS natively on webOS (UMS hardware decode). No HLS.js.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { showToast } from "../../toast.js";
import { formatTime } from "../../utils.js";
import { renderProbeLine } from "../../probeLabel.js";
import { createSidePanel, focusSidePanelItem } from "./sidePanel.js";
import { PlayerOsd } from "./playerOsd.js";
import { PlaybackController } from "./playbackController.js";

// How often playback progress is persisted to /api/playrecords while watching.
const RECORD_SAVE_INTERVAL_MS = 10000;
// Left/Right held longer than this on the focused progress bar enters the
// smooth scrub; a shorter press is a ±10s tap.
const SCRUB_HOLD_MS = 350;
import {
  getSourceProbeKey,
  rankSourcesByProbe
} from "../../../core/network/sourceRanking.js";
import {
  initialStallState,
  nextStallState,
  isStalled
} from "../../../core/playback/stallDetector.js";
import {
  initialAdSkipState,
  observeAdSkip
} from "../../../core/playback/adSkipDetector.js";
import {
  outroMarkKey,
  isValidOutroMark,
  getOutroFromEnd,
  shouldTriggerOutro
} from "../../../core/playback/outroMark.js";

export const PlayerScreen = {
  container: null,
  video: null,
  params: null,
  episodes: [],
  index: 0,
  paused: false,
  osd: null,
  playback: null,
  tickTimer: null,
  episodePanelVisible: false,
  episodePanelIndex: 0,
  sourcePanelVisible: false,
  sourcePanelIndex: 0,
  allSources: [],
  probeResults: new Map(),
  currentSourceKey: "",
  _keyUpHandler: null,    // document keyup listener (FocusEngine only forwards keydown)
  _listeners: [],
  resumeTime: 0,          // seconds to seek to when the initial episode loads
  _resumeApplied: false,
  recordMeta: null,       // { source, id, title, cover, source_name, year, total_episodes }
  _lastSaveAt: 0,
  _isExiting: false,      // re-entrancy guard for stop+exit (back key / error / ended)
  _stall: null,           // stallDetector state; see _tick
  _stallArmed: false,     // only watch the clock once this load has actually played a frame
  _adSkip: null,          // pre-scan ranges + live fallback; see adSkipDetector.js
  _outroTriggered: false, // one-shot guard for the current episode's auto-advance

  async mount(params = {}) {
    this.container = document.getElementById("player");
    this.params = params;
    this.episodes = Array.isArray(params.episodes) ? params.episodes : [];
    this.index = Math.max(0, Math.min(params.index || 0, this.episodes.length - 1));
    this.paused = false;
    this.episodePanelVisible = false;
    this.episodePanelIndex = this.index;
    this.sourcePanelVisible = false;
    this.sourcePanelIndex = 0;
    this.allSources = Array.isArray(params.allSources) ? params.allSources : [];
    this.probeResults = new Map(
      Array.isArray(params.probeResults) ? params.probeResults.map(([k, v]) => [k, v]) : []
    );
    this.currentSourceKey = params.currentSourceKey || "";
    this._listeners = [];
    this.resumeTime = Math.max(0, Number(params.resumeTime || 0));
    this._resumeApplied = false;
    this.recordMeta = params.record || null;
    this._lastSaveAt = 0;
    this._isExiting = false;
    this._stall = initialStallState();
    this._stallArmed = false;
    this._adSkip = initialAdSkipState();
    this._outroTriggered = false;

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
            <div class="player-osd-stats" id="playerOsdStats"></div>
          </div>
          <div class="player-controls-bottom">
            <div class="player-progress-track" id="playerProgress">
              <div class="player-progress-fill" id="playerProgressFill"></div>
              <div class="player-progress-outro" id="playerProgressOutro" style="display:none;"></div>
              <div class="player-progress-thumb" id="playerProgressThumb"></div>
              <div class="player-progress-bubble" id="playerProgressBubble">0:00</div>
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
    this.playback = new PlaybackController({
      video: this.video,
      params: this.params,
      episodes: this.episodes,
      index: this.index,
      allSources: this.allSources,
      probeResults: this.probeResults,
      currentSourceKey: this.currentSourceKey,
      resumeTime: this.resumeTime,
      recordMeta: this.recordMeta,
      onStateChange: (controller) => {
        this.params = controller.params;
        this.episodes = controller.episodes;
        this.index = controller.index;
        this.allSources = controller.allSources;
        this.probeResults = controller.probeResults;
        this.currentSourceKey = controller.currentSourceKey;
        this.resumeTime = controller.resumeTime;
        this._resumeApplied = controller.resumeApplied;
        this._lastSaveAt = controller.lastSaveAt;
        this.recordMeta = controller.recordMeta;
        this._renderButtons();
      },
      onMetaChange: () => this._updateMeta(),
      onAdSkipState: (state) => { this._adSkip = state; },
      onSourcePanelClose: () => this._closeSourcePanel(),
      onRouteBack: () => Router.back(),
      onExit: () => {
        this._isExiting = true;
        if (this.container) {
          this.container.style.transition = "opacity 200ms ease";
          this.container.style.opacity = "0";
        }
      },
      toast: showToast,
    });
    this.osd = new PlayerOsd({
      container: this.container,
      getVideo: () => this.video,
      getTitle: () => this.params?.title || "",
      getSourceName: () => this.params?.sourceName || "",
      getEpisodes: () => this.episodes,
      getIndex: () => this.index,
      getAllSources: () => this.allSources,
      getPaused: () => this.paused,
      getOutroMark: () => this._getOutroMark(),
      getEpisodePanelVisible: () => this.episodePanelVisible,
      getSourcePanelVisible: () => this.sourcePanelVisible,
      onPanelsHidden: () => {
        this.episodePanelVisible = false;
        this.sourcePanelVisible = false;
        this.container.querySelector("#playerEpisodePanel")?.remove();
        this.container.querySelector("#playerSourcePanel")?.remove();
        this._renderButtons();
      },
    });

    ScreenUtils.show(this.container);
    this._renderButtons();
    this._bindVideo();
    this._playIndex(this.index);

    this.tickTimer = setInterval(() => this._tick(), 500);
    this._resetControlsAutoHide();
    // FocusEngine forwards keydown only; the scrub commit needs the real keyup.
    this._keyUpHandler = (e) => this.osd?.onKeyUp(e);
    document.addEventListener("keyup", this._keyUpHandler, true);
    this._focusProgress();
  },

  _renderButtons() {
    this.osd?.renderButtons();
  },

  _bindVideo() {
    const v = this.video;
    const on = (ev, fn) => { v.addEventListener(ev, fn); this._listeners.push([ev, fn]); };
    on("loadstart", () => {
      this.container.querySelector("#playerLoading")?.classList.remove("hidden");
      // A new load has its own startup buffering; nothing to watch yet.
      this._disarmStall();
    });
    // Buffer underrun. Legitimate on a slow network, and also the first visible
    // symptom of the frozen-demuxer failure, so show the spinner either way —
    // without it a stall is indistinguishable from a still frame.
    on("waiting", () => this.container.querySelector("#playerLoading")?.classList.remove("hidden"));
    on("canplay", () => {
      this.container.querySelector("#playerLoading")?.classList.add("hidden");
      this._applyResume();
    });
    on("loadedmetadata", () => {
      this._applyResume();
      this._updateResolutionFromVideo();
    });
    on("playing", () => {
      this.paused = false;
      this.container.querySelector("#playerLoading")?.classList.add("hidden");
      // Frames are actually being produced — from here on the clock is expected
      // to move, so a frozen currentTime means something broke.
      this._stallArmed = true;
      this._stall = initialStallState();
      this._renderButtons();
    });
    on("pause", () => { this.paused = true; this._renderButtons(); this._saveRecord(true); });
    on("ended", () => this._handleEnded());
    on("error", (e) => {
      this.container.querySelector("#playerLoading")?.classList.add("hidden");
      const v = this.video;
      const debug = {
        sourceKey: this.currentSourceKey,
        sourceName: this.params?.sourceName || "",
        url: this.episodes?.[this.index] || "",
        episode: this.index + 1,
        videoState: {
          readyState: v?.readyState,
          networkState: v?.networkState,
          error: v?.error ? { code: v.error.code, message: v.error.message } : null,
          currentTime: v?.currentTime,
          duration: v?.duration,
          videoWidth: v?.videoWidth,
          videoHeight: v?.videoHeight,
        },
      };
      console.error("[DecoTV] playback error", JSON.stringify(debug));
      this._handlePlaybackError(debug);
    });
  },

  async _playIndex(idx) {
    return this.playback?.playIndex(idx);
  },

  _updateMeta() {
    this.osd?.updateMeta();
  },

  _updateOsdStats() {
    this.osd?.updateStats();
  },

  _updateResolutionFromVideo() {
    this.osd?.updateStats();
  },

  _renderProgress(cur, dur) {
    this.osd?.renderProgress(cur, dur);
  },

  _tick() {
    const v = this.video;
    if (!v) return;
    // While scrubbing, the preview position owns the bar.
    if (!this.osd?.scrub.active) this._renderProgress(v.currentTime || 0, v.duration || 0);
    this._updateOsdStats();
    if (!this._resumeApplied) this._applyResume(); // retry until metadata is ready
    // Persist progress periodically while actually playing.
    const cur = v.currentTime || 0;
    if (!v.paused && cur > 0) {
      const now = Date.now();
      if (now - this._lastSaveAt >= RECORD_SAVE_INTERVAL_MS) this._saveRecord();
    }
    this._checkStall(v);
    this._checkAdSkip(v);
    this._checkOutroMark(v);
    this._updateOutroMarker(v);
  },

  // The outro mark is a fact about the timeline, so it is drawn on the
  // timeline: a tick + tinted zone from the trigger point to the end.
  // Kept in _tick because duration arrives late and changes per episode.
  _updateOutroMarker(v) {
    this.osd?.updateOutroMarker(v);
  },

  _checkOutroMark(v) {
    if (!shouldTriggerOutro({
      episodesLength: this.episodes.length,
      index: this.index,
      paused: this.paused || v.paused,
      seeking: v.seeking,
      ended: v.ended,
      currentTime: v.currentTime,
      duration: v.duration,
      mark: this._getOutroMark(),
      isExiting: this._isExiting,
      outroTriggered: this._outroTriggered,
    })) return;

    this._outroTriggered = true;
    showToast("已跳过片尾");
    this._playIndex(this.index + 1);
  },

  // Prefer pre-scanned ad ranges (one seek to range.end). Fall back to live
  // videoWidth/Height outlier crawl only when the scan found nothing.
  _checkAdSkip(v) {
    const adSkip = this.playback?.adSkip || this._adSkip;
    if (this._isExiting || !adSkip) return;
    const result = observeAdSkip(adSkip, {
      w: v.videoWidth || 0,
      h: v.videoHeight || 0,
      currentTime: v.currentTime || 0,
      duration: v.duration || 0,
      paused: v.paused,
      seeking: v.seeking,
      ended: v.ended,
      now: Date.now()
    });
    this._adSkip = result.state;
    if (this.playback) this.playback.adSkip = result.state;
    const action = result.action;
    if (!action) return;
    if (action.toast) showToast(action.toast, 2200);
    if (action.type === "seek" && Number.isFinite(action.to)) {
      if (action.to > (v.currentTime || 0) + 0.25) {
        try {
          v.currentTime = action.to;
        } catch (_) { /* ignore seek errors on closed pipelines */ }
      }
    }
  },

  // Watch for playback that reports itself as running while the clock stands
  // still. See stallDetector.js for why the `error` event cannot be relied on.
  _checkStall(v) {
    if (!this._stallArmed || this._isExiting) return;
    this._stall = nextStallState(this._stall, {
      currentTime: v.currentTime || 0,
      paused: v.paused,
      seeking: v.seeking,
      ended: v.ended,
      now: Date.now()
    });
    if (!isStalled(this._stall)) return;
    // Read before disarming — _disarmStall resets the counter.
    const stalledMs = this._stall.stalledMs;
    // Disarm so the handler cannot re-enter on the next tick; switching sources
    // triggers a fresh load and the next `playing` re-arms.
    this._disarmStall();
    console.error("[DecoTV] playback stalled", JSON.stringify({
      sourceKey: this.currentSourceKey,
      sourceName: this.params?.sourceName || "",
      frozenAt: v.currentTime,
      stalledMs,
      readyState: v.readyState,
      networkState: v.networkState
    }));
    this._handlePlaybackError({
      sourceKey: this.currentSourceKey,
      sourceName: this.params?.sourceName || "",
      url: this.episodes?.[this.index] || "",
      stalled: true,
      frozenAt: v.currentTime
    });
  },

  _disarmStall() {
    this._stallArmed = false;
    this._stall = initialStallState();
  },

  // Seek to the resume position once, when the initial episode's duration is
  // known. If metadata is not ready yet, leave it unapplied so a later
  // canplay / loadedmetadata / tick retries.
  _applyResume() {
    this.playback?.applyResume();
  },

  _saveRecord(force = false) {
    this.playback?.saveRecord(force);
    if (this.playback) this._lastSaveAt = this.playback.lastSaveAt;
  },

  _handleEnded() {
    this._advanceOrExit();
  },

  _handlePlaybackError(debug) {
    this.playback?.handlePlaybackError(debug);
  },

  _advanceOrExit() {
    this.playback?.advanceOrExit();
  },

  setControlsVisible(visible) {
    this.osd?.setVisible(visible);
  },

  _resetControlsAutoHide() {
    this.osd?.resetAutoHide();
  },

  _focusDefaultButton() {
    this.osd?.focusDefaultButton();
  },

  // ── Focus zones ────────────────────────────────────────────────────────────
  _focusProgress() {
    this.osd?.focusProgress();
  },

  _focusButtons() {
    this.osd?.focusButtons();
  },

  // ── Left/Right on the progress bar: tap = ±10s, hold = accelerating scrub ──
  // FocusEngine forwards keydown without the `repeat` flag, so repeats are
  // recognized by `pressed` already being set. The preview position moves on a
  // rAF loop (8x → ~96x as the key is held) and only commits to the video on
  // keyup — one seek instead of a seek per repeat.
  _outroMarkKey() {
    const meta = this.recordMeta || {};
    return outroMarkKey(
      meta.title || this.params?.title || "",
      meta.year || this.params?.year || ""
    );
  },

  _getOutroMark() {
    const key = this._outroMarkKey();
    return key ? LocalLibrary.getOutroMark(key) : null;
  },

  _toggleOutroMark() {
    if (this.episodes.length <= 1) return;
    const key = this._outroMarkKey();
    const v = this.video;
    const duration = Number(v?.duration);
    const currentTime = Number(v?.currentTime);
    if (!key || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) {
      showToast("片尾标记暂不可用");
      return;
    }

    const existing = LocalLibrary.getOutroMark(key);
    if (isValidOutroMark(existing, duration)
      && currentTime >= duration - Number(existing.fromEnd)) {
      LocalLibrary.deleteOutroMark(key);
      showToast("已取消片尾标记");
    } else {
      const fromEnd = getOutroFromEnd(currentTime, duration);
      if (fromEnd === null) {
        showToast("标记位置需距片尾至少 1 秒");
        return;
      }
      LocalLibrary.saveOutroMark(key, { fromEnd, markedAt: Date.now() });
      showToast("已标记片尾，本剧各集播到此处自动下一集");
    }
    // No button re-render: the mark state is drawn on the progress bar, and
    // rebuilding the buttons here is what used to silently drop focus.
    this._updateOutroMarker(this.video);
    this.setControlsVisible(true);
  },

  _playPreviousEpisode() {
    if (this.episodes.length <= 1 || this.index <= 0) return;
    this.setControlsVisible(true);
    this._playIndex(this.index - 1);
  },

  _playNextEpisode() {
    if (this.episodes.length <= 1 || this.index >= this.episodes.length - 1) return;
    this.setControlsVisible(true);
    this._playIndex(this.index + 1);
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
    const ranked = rankSourcesByProbe(this.allSources, this.probeResults);
    const items = ranked.map((src, i) => {
      const key = getSourceProbeKey(src);
      const r = this.probeResults.get(key);
      return {
        label: `${src.source_name || src.source}${key === this.currentSourceKey ? " · 正在播放" : ""}`,
        subHtml: renderProbeLine(r),
        selected: key === this.currentSourceKey,
        attrs: { "data-panel-source-key": key, "data-panel-index": i },
      };
    });
    const panel = createSidePanel({
      id: "playerSourcePanel",
      title: "播放源",
      hint: "▲▼ 选择 · OK 切换并重播 · 返回 关闭",
      listId: "playerSourceList",
      items,
    });
    this.container.appendChild(panel);
    ScreenUtils.indexFocusables(panel, ".focusable");
    const targetKey = getSourceProbeKey(this.allSources[this.sourcePanelIndex] || this.allSources[0]);
    const target = Array.from(panel.querySelectorAll(".player-side-item"))
      .find((node) => node.dataset.panelSourceKey === targetKey);
    const targetIndex = target?.dataset.panelIndex ?? "0";
    focusSidePanelItem(panel, `[data-panel-index="${targetIndex}"]`);
  },

  _closeSourcePanel() {
    this.sourcePanelVisible = false;
    this.container.querySelector("#playerSourcePanel")?.remove();
    this._renderButtons();
    const btn = this.container.querySelector('.player-control-btn[data-ctrl="sourcePanel"]');
    if (btn) ScreenUtils.setFocus(btn, this.container);
    this._resetControlsAutoHide();
  },

  // opts.resumeAt — seconds to pick up from on the new source. Omitted for a
  // manual switch, which deliberately restarts the episode.
  _switchToSourceKey(key, opts = {}) {
    this.playback?.switchToSourceKey(key, opts);
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
    const panel = createSidePanel({
      id: "playerEpisodePanel",
      title: "剧集列表",
      hint: "▲▼ 选择 · OK 播放 · 返回 关闭",
      listId: "playerEpisodeList",
      items: this.episodes.map((_, i) => ({
        label: `第 ${i + 1} 集`,
        sub: i === this.index ? "正在播放" : "",
        selected: i === this.episodePanelIndex,
        attrs: { "data-panel-index": i },
      })),
    });
    this.container.appendChild(panel);
    ScreenUtils.indexFocusables(panel);
    focusSidePanelItem(panel, `[data-panel-index="${this.episodePanelIndex}"]`);
  },

  _closeEpisodePanel() {
    this.episodePanelVisible = false;
    this.container.querySelector("#playerEpisodePanel")?.remove();
    this._renderButtons();
    const btn = this.container.querySelector('.player-control-btn[data-ctrl="episodePanel"]');
    if (btn) ScreenUtils.setFocus(btn, this.container);
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

    if (code === 33 || code === 34) {
      event.preventDefault?.();
      if (code === 33) this._playPreviousEpisode();
      else this._playNextEpisode();
      return;
    }

    // No panel: two focus zones inside the controls overlay — the progress bar
    // (default; Left/Right seek and hold-scrub there) and the button row below
    // (Down enters it, Up returns). Hiding the bar strips every .focused and
    // resets the zone, so there is no stale-focus state to gate against.

    // Down → reveal the bar, or hand focus from the bar to the buttons.
    if (code === 40) {
      if (!this.osd.controlsVisible) { this.setControlsVisible(true); return; }
      if (this.osd.focusZone === "progress") this._focusButtons();
      this._resetControlsAutoHide();
      return;
    }

    // Up → from the buttons back to the bar. On the bar it only reveals the
    // controls; the old "open episode list" shortcut is gone — the list is a
    // button now that the row is reachable by focus.
    if (code === 38) {
      if (!this.osd.controlsVisible) { this.setControlsVisible(true); return; }
      if (this.osd.focusZone === "buttons") this._focusProgress();
      this._resetControlsAutoHide();
      return;
    }

    // Left/Right: on the progress bar tap = ±10s / hold = smooth scrub; on the
    // buttons it moves button focus. While hidden it reveals the bar first and
    // the same press already starts seeking.
    if (code === 37 || code === 39) {
      if (!this.osd.controlsVisible) this.setControlsVisible(true);
      if (this.osd.focusZone === "progress") {
        this.osd.scrubKeyDown(code === 37 ? -1 : 1);
      } else {
        ScreenUtils.moveFocusDirectional(this.container, code === 37 ? "left" : "right", ".player-control-btn.focusable");
      }
      this._resetControlsAutoHide();
      return;
    }

    if (code === 13) {
      if (this.osd.controlsVisible && this.osd.focusZone === "buttons") {
        const focusedBtn = this.container.querySelector(".player-control-btn.focused");
        if (focusedBtn) { this._performControlAction(focusedBtn.dataset.ctrl); return; }
      }
      // On the bar (or with the bar hidden): toggle play/pause + show controls.
      this.osd.togglePlayPause();
      return;
    }
    if (code === 32) { this.osd.togglePlayPause(); return; } // space (dev)
    if (code === 461 || code === 27 || code === 8) {
      this._stopAndExit();
      return;
    }
  },

  _performControlAction(action) {
    switch (action) {
      case "playPause": this.osd.togglePlayPause(); break;
      case "prevEp": this._playPreviousEpisode(); break;
      case "nextEp": this._playNextEpisode(); break;
      case "markOutro": this._toggleOutroMark(); break;
      case "sourcePanel": this._toggleSourcePanel(); break;
      case "episodePanel": this._toggleEpisodePanel(); break;
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
    this.playback?.stopAndExit();
  },

  cleanup() {
    // Persist final position and cancel background scans before tearing down.
    this.playback?.cleanup();
    if (this._keyUpHandler) {
      document.removeEventListener("keyup", this._keyUpHandler, true);
      this._keyUpHandler = null;
    }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.osd?.cleanup();
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
  }
};
