// playerScreen.js — minimal video player with OSD + episode switcher.
// <video> plays HLS natively on webOS (UMS hardware decode). No HLS.js.

import { ScreenUtils } from "../../navigation/screen.js";
import { Router } from "../../navigation/router.js";
import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { LibrarySync } from "../../../core/storage/librarySync.js";
import { showToast } from "../../toast.js";
import { escapeHtml, escapeAttr, formatTime } from "../../utils.js";

// How often playback progress is persisted to /api/playrecords while watching.
const RECORD_SAVE_INTERVAL_MS = 10000;
// Left/Right held longer than this on the focused progress bar enters the
// smooth scrub; a shorter press is a ±10s tap.
const SCRUB_HOLD_MS = 350;
import {
  getSourceProbeKey,
  isVerifiedPlaybackResult,
  rankSourcesByProbe,
  pickBestAvailableSource
} from "../../../core/network/sourceRanking.js";
import {
  initialStallState,
  nextStallState,
  isStalled
} from "../../../core/playback/stallDetector.js";
import {
  initialAdSkipState,
  observeAdSkip,
  applyScanResult,
  markScanRunning,
  markScanFailed
} from "../../../core/playback/adSkipDetector.js";
import {
  scanAdRanges,
  isHlsPlayUrl
} from "../../../core/playback/adSkipScanner.js";

// Monochrome inline SVG glyphs (inherit button color via currentColor) —
// replaces the colored system emoji that rendered as ugly yellow icons.
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  // Previous / next episode (skip-previous / skip-next).
  prevEp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h2v14H5zM18 6l-9 6 9 6z"/></svg>',
  nextEp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l9 6-9 6zM17 5h2v14h-2z"/></svg>'
};

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
  failedSourceKeys: new Set(),
  currentSourceKey: "",
  // Two focus zones inside the controls overlay: the progress bar (default —
  // it is a first-class focus stop) and the button row below it.
  focusZone: "progress",
  _scrub: null,           // Left/Right hold-to-scrub state; see _scrubKeyDown
  _keyUpHandler: null,    // document keyup listener (FocusEngine only forwards keydown)
  _listeners: [],
  resumeTime: 0,          // seconds to seek to when the initial episode loads
  _resumeApplied: false,
  recordMeta: null,       // { source, id, title, cover, source_name, year, total_episodes }
  _lastSaveAt: 0,
  _isExiting: false,      // re-entrancy guard for stop+exit (back key / error / ended)
  _playToken: 0,          // race guard: each _playIndex call gets a token; stale async results are discarded
  _stall: null,           // stallDetector state; see _tick
  _stallArmed: false,     // only watch the clock once this load has actually played a frame
  _adSkip: null,          // pre-scan ranges + live fallback; see adSkipDetector.js
  _adScanAbort: null,     // AbortController for in-flight playlist pre-scan
  _outroTriggered: false, // one-shot guard for the current episode's auto-advance

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
    this.failedSourceKeys = new Set();
    this.currentSourceKey = params.currentSourceKey || "";
    this.focusZone = "progress";
    this._scrub = { pressed: false, active: false, dir: 0, holdTimer: 0, raf: 0, previewSec: 0, ts: 0, last: 0 };
    this._listeners = [];
    this.resumeTime = Math.max(0, Number(params.resumeTime || 0));
    this._resumeApplied = false;
    this.recordMeta = params.record || null;
    this._lastSaveAt = 0;
    this._isExiting = false;
    this._playToken = 0;
    this._stall = initialStallState();
    this._stallArmed = false;
    this._adSkip = initialAdSkipState();
    this._adScanAbort = null;
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

    ScreenUtils.show(this.container);
    this._renderButtons();
    this._bindVideo();
    this._playIndex(this.index);

    this.tickTimer = setInterval(() => this._tick(), 500);
    this._resetControlsAutoHide();
    // FocusEngine forwards keydown only; the scrub commit needs the real keyup.
    this._keyUpHandler = (e) => this._onKeyUp(e);
    document.addEventListener("keyup", this._keyUpHandler, true);
    this._focusProgress();
  },

  _renderButtons() {
    const wrap = this.container.querySelector("#playerButtons");
    // Standard transport cluster (⏮ ⏯ ⏭) first, text pills by usage frequency.
    // markOutro sits at the far end: it is the rarest action and the one where
    // an accidental press is most annoying. Its "marked" state lives on the
    // progress bar (see _updateOutroMarker), never on the button — a solid
    // fill on the bar is reserved for focus and nothing else.
    const defs = [
      { action: "prevEp", label: ICONS.prevEp, disabled: this.episodes.length <= 1 || this.index <= 0 },
      { action: "playPause", label: this.paused ? ICONS.play : ICONS.pause },
      { action: "nextEp", label: ICONS.nextEp, disabled: this.episodes.length <= 1 || this.index >= this.episodes.length - 1 },
      { action: "episodePanel", label: "列表", text: true, active: this.episodePanelVisible, disabled: this.episodes.length <= 1 },
      { action: "sourcePanel", label: "换源", text: true, active: this.sourcePanelVisible, disabled: this.allSources.length <= 1 },
      { action: "markOutro", label: "标记片尾", text: true, disabled: this.episodes.length <= 1 }
    ];
    // Rebuilding innerHTML drops the .focused class; without restoring it the
    // next left/right lands nowhere — the "phantom focus" misoperation. Carry
    // focus across the rebuild only while the button zone owns it (fall back
    // to play/pause when the previously focused button became disabled, e.g.
    // nextEp on the last episode). In the progress zone the bar keeps focus.
    const focusedCtrl = wrap.querySelector(".player-control-btn.focused")?.dataset?.ctrl || null;
    wrap.innerHTML = defs.map((d) => `
      <button class="player-control-btn${d.text ? " player-control-btn-text" : ""}${d.active ? " active" : ""}${d.disabled ? "" : " focusable"}"
        data-ctrl="${d.action}" ${d.disabled ? "disabled" : ""}>${d.label}</button>
    `).join("");
    if (this.focusZone === "buttons") {
      const target = wrap.querySelector(`.player-control-btn.focusable[data-ctrl="${focusedCtrl}"]`)
        || wrap.querySelector('.player-control-btn[data-ctrl="playPause"]');
      if (target) {
        target.classList.add("focused");
        target.focus();
      }
    }
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
    if (idx < 0 || idx >= this.episodes.length) return;
    // Race guard: each call gets a unique token. After any await, if the token
    // no longer matches, a newer _playIndex has started — abort silently.
    const token = ++this._playToken;
    // Switching episodes (panel pick / auto-advance): persist the outgoing
    // episode first, then start the new one from the beginning (no resume).
    const switching = this._resumeApplied || idx !== this.index;
    if (switching) {
      this._saveRecord(true);
      this.resumeTime = 0;
      this._resumeApplied = false;
    }
    this.index = idx;
    this.episodePanelIndex = idx;
    this._outroTriggered = false;
    // Episode boundaries change which prev/next buttons are available.
    this._renderButtons();
    // Fresh episode/source — cancel any prior ad pre-scan and start clean.
    this._cancelAdScan();
    this._adSkip = initialAdSkipState();
    const rawUrl = this.episodes[idx];
    this.container.querySelector("#playerLoading")?.classList.remove("hidden");

    // Resolve playback page URLs to direct m3u8/mp4 via DecoTV server.
    // Resource sites return HTML player pages (e.g. /play/xxx); the native
    // <video> element cannot parse them. /api/playback/resolve fetches the
    // page and extracts the real stream URL.
    let playUrl = rawUrl;
    if (rawUrl && !this._isDirectMediaUrl(rawUrl)) {
      const source = this._currentSourceName();
      try {
        const res = await api.resolvePlayback(rawUrl, source);
        if (token !== this._playToken) return; // stale — newer _playIndex won
        if (res?.playbackUrl) playUrl = res.playbackUrl;
        else if (res?.resolvedUrl) playUrl = res.resolvedUrl;
        else {
          // Resolve returned no usable URL — treat as source failure.
          console.error("[DecoTV] resolvePlayback empty", { rawUrl, source, res });
          this._handlePlaybackError({ sourceKey: this.currentSourceKey, sourceName: this.params?.sourceName || "", url: rawUrl, resolveEmpty: true });
          return;
        }
      } catch (e) {
        if (token !== this._playToken) return; // stale — newer _playIndex won
        // Resolve failed (502/timeout/etc) — don't feed raw page URL to video.
        console.error("[DecoTV] resolvePlayback failed", { rawUrl, source, error: e?.message || e });
        this._handlePlaybackError({ sourceKey: this.currentSourceKey, sourceName: this.params?.sourceName || "", url: rawUrl, resolveError: e?.message || String(e) });
        return;
      }
    }

    this.video.src = playUrl;
    this.video.load();
    const playPromise = this.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => { /* autoplay restriction — user must press play */ });
    }
    this._updateMeta();
    // Background: probe discontinuity groups so mid-roll ads can be skipped in
    // one seek. Does not block play — watch for startup jank from the extra GETs.
    this._startAdScan(playUrl, token);
  },

  _cancelAdScan() {
    if (this._adScanAbort) {
      try { this._adScanAbort.abort(); } catch (_) {}
      this._adScanAbort = null;
    }
  },

  _startAdScan(playUrl, token) {
    if (!isHlsPlayUrl(playUrl)) return;
    this._cancelAdScan();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    this._adScanAbort = ctrl;
    this._adSkip = markScanRunning(this._adSkip || initialAdSkipState());
    const started = Date.now();
    scanAdRanges(playUrl, { signal: ctrl?.signal, concurrency: 2 })
      .then((result) => {
        if (token !== this._playToken) return;
        this._adSkip = applyScanResult(this._adSkip || initialAdSkipState(), result);
        console.info("[DecoTV] ad pre-scan", JSON.stringify({
          ranges: result.ranges?.length || 0,
          groups: result.groups,
          probed: result.probed,
          elapsedMs: result.elapsedMs,
          baseline: result.baseline,
          wallMs: Date.now() - started
        }));
      })
      .catch((err) => {
        if (token !== this._playToken) return;
        if (err?.name === "AbortError") return;
        this._adSkip = markScanFailed(this._adSkip || initialAdSkipState());
        console.warn("[DecoTV] ad pre-scan failed", err?.message || err);
      })
      .finally(() => {
        if (this._adScanAbort === ctrl) this._adScanAbort = null;
      });
  },

  // Check if URL is already a direct media stream (m3u8/mp4/etc) that <video>
  // can play without server-side resolution.
  _isDirectMediaUrl(url) {
    if (!url) return false;
    // Internal proxy URLs are already playable.
    if (url.includes("/api/proxy/m3u8")) return true;
    // Direct media file extensions.
    return /\.(m3u8|mp4|m4v|webm|mkv|mov|flv)(\?|#|$)/i.test(url);
  },

  // Extract source key for resolve API from current source.
  _currentSourceName() {
    const src = this.allSources.find((s) => getSourceProbeKey(s) === this.currentSourceKey);
    return src?.source || this.currentSourceKey?.split("-")[0] || "";
  },

  _updateMeta() {
    const title = this.params?.title || "";
    const sourceName = this.params?.sourceName || "";
    const epLabel = this.episodes.length > 1 ? `第 ${this.index + 1} 集 / 共 ${this.episodes.length} 集` : "";
    this.container.querySelector("#playerTitle").textContent = title;
    this.container.querySelector("#playerSubtitle").textContent =
      [sourceName, epLabel].filter(Boolean).join(" · ");
    this._updateOsdStats();
  },

  // Update OSD with real-time decode resolution + buffer length.
  // Called from _updateMeta, loadedmetadata, and _tick.
  _updateOsdStats() {
    const el = this.container.querySelector("#playerOsdStats");
    if (!el) return;
    const v = this.video;
    const parts = [];
    // Actual decode resolution from video element.
    if (v && v.videoWidth && v.videoHeight) {
      parts.push(`${v.videoWidth}×${v.videoHeight}`);
    }
    // Buffer length ahead of current position.
    if (v && v.buffered && v.buffered.length > 0) {
      const cur = v.currentTime || 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= cur && v.buffered.end(i) >= cur) {
          const bufSec = v.buffered.end(i) - cur;
          if (bufSec > 0) parts.push(`缓冲 ${bufSec.toFixed(0)}s`);
          break;
        }
      }
    }
    el.textContent = parts.join(" · ");
  },

  // Read actual decode resolution from the video element and update OSD.
  _updateResolutionFromVideo() {
    this._updateOsdStats();
  },

  _renderProgress(cur, dur) {
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    this.container.querySelector("#playerProgressFill").style.width = `${pct}%`;
    this.container.querySelector("#playerProgressThumb").style.left = `${pct}%`;
    this.container.querySelector("#playerTime").textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    // The bubble rides the thumb; CSS shows it during a scrub only.
    const bubble = this.container.querySelector("#playerProgressBubble");
    if (bubble) {
      bubble.style.left = `${pct}%`;
      bubble.textContent = formatTime(cur);
    }
  },

  _tick() {
    const v = this.video;
    if (!v) return;
    // While scrubbing, the preview position owns the bar.
    if (!this._scrub?.active) this._renderProgress(v.currentTime || 0, v.duration || 0);
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
    const el = this.container.querySelector("#playerProgressOutro");
    if (!el) return;
    const duration = Number(v?.duration);
    const mark = this._getOutroMark();
    if (this.episodes.length <= 1 || !this._isValidOutroMark(mark, duration)) {
      el.style.display = "none";
      return;
    }
    const pct = Math.max(0, Math.min(100, (1 - Number(mark.fromEnd) / duration) * 100));
    el.style.left = `${pct}%`;
    el.style.display = "block";
  },

  _checkOutroMark(v) {
    if (this._isExiting || this._outroTriggered) return;
    if (this.episodes.length <= 1 || this.index >= this.episodes.length - 1) return;
    if (this.paused || v.paused || v.seeking || v.ended) return;

    const duration = Number(v.duration);
    const currentTime = Number(v.currentTime);
    const mark = this._getOutroMark();
    if (!Number.isFinite(currentTime) || !this._isValidOutroMark(mark, duration)) return;
    const fromEnd = Number(mark.fromEnd);
    if (currentTime < duration - fromEnd) return;

    this._outroTriggered = true;
    showToast("已跳过片尾");
    this._playIndex(this.index + 1);
  },

  // Prefer pre-scanned ad ranges (one seek to range.end). Fall back to live
  // videoWidth/Height outlier crawl only when the scan found nothing.
  _checkAdSkip(v) {
    if (this._isExiting || !this._adSkip) return;
    const result = observeAdSkip(this._adSkip, {
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
    // source/id are stored alongside even though the local key does not use
    // them: the server keys records per source, so without them a record can
    // never be mirrored (see librarySync.js).
    const record = {
      title: m.title,
      cover: m.cover || "",
      source_name: m.source_name || m.source,
      source: m.source || "",
      id: m.id || "",
      year: m.year || "",
      index: this.index + 1,
      total_episodes: m.total_episodes || this.episodes.length,
      play_time: cur,
      total_time: dur
    };
    LocalLibrary.savePlayRecord(key, record);
    LibrarySync.pushRecord({ ...record, save_time: Date.now() });
  },

  _handleEnded() {
    this._advanceOrExit();
  },

  // Playback error → mark current source failed, switch to next available.
  _handlePlaybackError(debug) {
    if (this._isExiting) return;
    this.failedSourceKeys.add(this.currentSourceKey);
    // Determine error label: prefer video.error.code (playback stage),
    // fall back to debug.resolveError/resolveEmpty (resolve stage).
    const v = this.video;
    const errCode = v?.error?.code;
    const errMap = { 1: "ABORTED", 2: "NETWORK", 3: "DECODE", 4: "SRC_NOT_SUPPORTED" };
    let errLabel = errMap[errCode] || "";
    if (debug?.stalled) errLabel = "STALL"; // no error code is set in this case
    if (!errLabel) {
      if (debug?.resolveError) errLabel = "RESOLVE_FAIL";
      else if (debug?.resolveEmpty) errLabel = "RESOLVE_EMPTY";
      else errLabel = "ERR";
    }
    const srcName = debug?.sourceName || "?";
    const failedCount = this.failedSourceKeys.size;
    const total = this.allSources.length;
    console.error(`[DecoTV] ${errLabel} on "${srcName}" (${failedCount}/${total} failed)`, debug);
    // Search order is not a quality ranking. Pick the best measured source
    // that has not failed instead of taking the first remaining result.
    const next = pickBestAvailableSource(
      this.allSources,
      this.probeResults,
      this.failedSourceKeys
    );
    if (next) {
      const key = getSourceProbeKey(next);
      showToast(`${errLabel} · ${srcName} → 换源`);
      // Failover should continue where playback died, not restart the episode.
      // (A manual switch from the side panel still starts at 0 — there the user
      // is choosing a source deliberately, not being rescued mid-scene.)
      this._switchToSourceKey(key, { resumeAt: v?.currentTime || 0 });
    } else {
      // All sources exhausted → back to detail.
      showToast(`全部源不可用 · ${errLabel}`);
      this._stopAndExit();
      Router.back();
    }
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
    const wasVisible = this.controlsVisible;
    this.controlsVisible = visible;
    const overlay = this.container.querySelector("#playerControls");
    if (!overlay) return;
    if (visible) {
      overlay.classList.remove("hidden");
      // The bar always reappears with the progress zone focused — hiding
      // stripped every .focused, so there is no stale button focus to trip on.
      if (!wasVisible) this._focusProgress();
      this._resetControlsAutoHide();
    } else {
      this._stopScrub(true);
      overlay.classList.add("hidden");
      this.container.querySelectorAll("#playerControls .focused").forEach((n) => n.classList.remove("focused"));
      this.focusZone = "progress";
    }
  },

  _resetControlsAutoHide() {
    if (this.controlsHideTimer) clearTimeout(this.controlsHideTimer);
    this.controlsHideTimer = setTimeout(() => {
      this.controlsHideTimer = null;
      // The floating source/episode panel follows the same five-second timer
      // as the playback bar. Keep both visible while paused or mid-scrub.
      if (this.paused || this._scrub?.active) return;
      const hadPanel = this.episodePanelVisible || this.sourcePanelVisible;
      this.episodePanelVisible = false;
      this.sourcePanelVisible = false;
      if (hadPanel) {
        this.container.querySelector("#playerEpisodePanel")?.remove();
        this.container.querySelector("#playerSourcePanel")?.remove();
        this._renderButtons();
      }
      this.setControlsVisible(false);
    }, 5000);
  },

  _focusDefaultButton() {
    const first = this.container.querySelector('.player-control-btn[data-ctrl="playPause"]');
    if (!first) return;
    this.container.querySelectorAll(".focused").forEach((n) => n.classList.remove("focused"));
    first.classList.add("focused");
    first.focus();
  },

  // ── Focus zones ────────────────────────────────────────────────────────────
  _focusProgress() {
    this.focusZone = "progress";
    this.container.querySelectorAll("#playerControls .focused").forEach((n) => n.classList.remove("focused"));
    this.container.querySelector("#playerProgress")?.classList.add("focused");
  },

  _focusButtons() {
    this.focusZone = "buttons";
    this.container.querySelector("#playerProgress")?.classList.remove("focused");
    this._focusDefaultButton();
  },

  // ── Left/Right on the progress bar: tap = ±10s, hold = accelerating scrub ──
  // FocusEngine forwards keydown without the `repeat` flag, so repeats are
  // recognized by `pressed` already being set. The preview position moves on a
  // rAF loop (8x → ~96x as the key is held) and only commits to the video on
  // keyup — one seek instead of a seek per repeat.
  _scrubKeyDown(dir) {
    const s = this._scrub;
    if (s.pressed) {
      // webOS key repeat: the hold timer (or the running scrub) owns it.
      if (!s.active && s.dir === dir && !s.holdTimer) this._startScrub(dir);
      return;
    }
    s.pressed = true;
    s.dir = dir;
    if (s.holdTimer) clearTimeout(s.holdTimer);
    s.holdTimer = setTimeout(() => { s.holdTimer = 0; this._startScrub(dir); }, SCRUB_HOLD_MS);
  },

  _startScrub(dir) {
    const v = this.video;
    if (!v || !(v.duration > 0)) return;
    const s = this._scrub;
    s.active = true;
    s.dir = dir;
    s.previewSec = v.currentTime || 0;
    s.ts = performance.now();
    s.last = 0;
    this.container.querySelector("#playerProgress")?.classList.add("scrubbing");
    if (!s.raf) s.raf = requestAnimationFrame((now) => this._scrubTick(now));
  },

  _scrubTick(now) {
    const s = this._scrub;
    const v = this.video;
    if (!s.active) { s.raf = 0; return; }
    if (!v || !(v.duration > 0)) { this._stopScrub(false); return; }
    const last = s.last || now;
    s.last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    const held = (now - s.ts) / 1000;
    const speed = 8 + Math.min(held, 4) * 22; // accelerate 8x → ~96x
    s.previewSec = Math.max(0, Math.min(v.duration, s.previewSec + s.dir * speed * dt));
    this._renderProgress(s.previewSec, v.duration);
    s.raf = requestAnimationFrame((n) => this._scrubTick(n));
  },

  _stopScrub(commit) {
    const s = this._scrub;
    if (!s) return;
    if (s.holdTimer) { clearTimeout(s.holdTimer); s.holdTimer = 0; }
    if (!s.active) return;
    s.active = false;
    s.last = 0;
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
    this.container.querySelector("#playerProgress")?.classList.remove("scrubbing");
    if (commit && this.video && this.video.duration > 0) {
      try { this.video.currentTime = s.previewSec; } catch (_) {}
    }
    this._resetControlsAutoHide();
  },

  _onKeyUp(event) {
    const code = Number(event.keyCode || 0);
    if (code !== 37 && code !== 39) return;
    const s = this._scrub;
    if (!s || !s.pressed) return;
    if (s.holdTimer) { clearTimeout(s.holdTimer); s.holdTimer = 0; }
    if (s.active) this._stopScrub(true);
    else this._seek(s.dir * 10); // short tap = ±10s
    s.pressed = false;
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

  _outroMarkKey() {
    const meta = this.recordMeta || {};
    const title = meta.title || this.params?.title || "";
    const year = meta.year || this.params?.year || "";
    if (!String(title).trim()) return "";
    return LocalLibrary.recordKeyForTitle(title, year);
  },

  _getOutroMark() {
    const key = this._outroMarkKey();
    return key ? LocalLibrary.getOutroMark(key) : null;
  },

  _isValidOutroMark(mark, duration) {
    const fromEnd = Number(mark?.fromEnd);
    const dur = Number(duration);
    return Number.isFinite(fromEnd)
      && fromEnd >= 1
      && Number.isFinite(dur)
      && dur > 0
      && fromEnd <= dur * 0.5;
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
    if (this._isValidOutroMark(existing, duration)
      && currentTime >= duration - Number(existing.fromEnd)) {
      LocalLibrary.deleteOutroMark(key);
      showToast("已取消片尾标记");
    } else {
      const fromEnd = duration - currentTime;
      if (!this._isValidOutroMark({ fromEnd }, duration)) {
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
            <div class="player-side-item${isCurrent ? " selected" : ""} focusable" data-panel-source-key="${escapeAttr(key)}" data-panel-index="${i}">
              <div class="player-side-item-label">${escapeHtml(src.source_name || src.source)}${isCurrent ? " · 正在播放" : ""}</div>
              <div class="player-side-item-sub">${probeLine}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
    this.container.appendChild(panel);
    ScreenUtils.indexFocusables(panel, ".focusable");
    const target = panel.querySelector(`[data-panel-source-key="${escapeAttr(getSourceProbeKey(this.allSources[this.sourcePanelIndex] || this.allSources[0]))}"]`)
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
    if (r.hasError || r.status === "failed") return `✕ ${escapeHtml((r.message || "失败").slice(0, 28))}`;
    if (isVerifiedPlaybackResult(r)) {
      const speed = r.speedKBps ? `${(r.speedKBps / 1024).toFixed(2)} MB/s` : (r.loadSpeed || "—");
      return `✓ ${escapeHtml(r.quality || "—")} · ${escapeHtml(speed)} · ${r.pingTime || 0} ms`;
    }
    return `◐ ${escapeHtml((r.message || "可播").slice(0, 28))}`;
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

  // opts.resumeAt — seconds to pick up from on the new source. Omitted for a
  // manual switch, which deliberately restarts the episode.
  _switchToSourceKey(key, opts = {}) {
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
    // Outgoing source already saved above. A manual switch starts the new
    // source cleanly at 0; an automatic failover passes resumeAt so the viewer
    // keeps their place instead of being thrown back to the opening titles.
    this.resumeTime = Math.max(0, Number(opts.resumeAt || 0));
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
      if (!this.controlsVisible) { this.setControlsVisible(true); return; }
      if (this.focusZone === "progress") this._focusButtons();
      this._resetControlsAutoHide();
      return;
    }

    // Up → from the buttons back to the bar. On the bar it only reveals the
    // controls; the old "open episode list" shortcut is gone — the list is a
    // button now that the row is reachable by focus.
    if (code === 38) {
      if (!this.controlsVisible) { this.setControlsVisible(true); return; }
      if (this.focusZone === "buttons") this._focusProgress();
      this._resetControlsAutoHide();
      return;
    }

    // Left/Right: on the progress bar tap = ±10s / hold = smooth scrub; on the
    // buttons it moves button focus. While hidden it reveals the bar first and
    // the same press already starts seeking.
    if (code === 37 || code === 39) {
      if (!this.controlsVisible) this.setControlsVisible(true);
      if (this.focusZone === "progress") {
        this._scrubKeyDown(code === 37 ? -1 : 1);
      } else {
        ScreenUtils.moveFocusDirectional(this.container, code === 37 ? "left" : "right", ".player-control-btn.focusable");
      }
      this._resetControlsAutoHide();
      return;
    }

    if (code === 13) {
      if (this.controlsVisible && this.focusZone === "buttons") {
        const focusedBtn = this.container.querySelector(".player-control-btn.focused");
        if (focusedBtn) { this._performControlAction(focusedBtn.dataset.ctrl); return; }
      }
      // On the bar (or with the bar hidden): toggle play/pause + show controls.
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
    this._cancelAdScan();
    // Persist final position before tearing the video down.
    this._saveRecord(true);
    this._stopScrub(false);
    if (this._scrub) this._scrub.pressed = false;
    if (this._keyUpHandler) {
      document.removeEventListener("keyup", this._keyUpHandler, true);
      this._keyUpHandler = null;
    }
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
  }
};
