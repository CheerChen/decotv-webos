// playbackController.js — non-DOM playback state machine and persistence.

import { api } from "../../../core/network/decotvClient.js";
import { LocalLibrary } from "../../../core/storage/localLibrary.js";
import { LibrarySync } from "../../../core/storage/librarySync.js";
import { formatTime } from "../../utils.js";
import { showToast as defaultShowToast } from "../../toast.js";
import {
  getSourceProbeKey,
  pickBestAvailableSource,
} from "../../../core/network/sourceRanking.js";
import {
  initialAdSkipState,
  applyScanResult,
  markScanRunning,
  markScanFailed,
} from "../../../core/playback/adSkipDetector.js";
import { scanAdRanges, isHlsPlayUrl, isLocalProxyUrl } from "../../../core/playback/adSkipScanner.js";
import { getM3u8ProxyPort, subscribeKeepalive } from "../../../core/network/lunaTransport.js";

export class PlaybackController {
  constructor({
    video,
    params = {},
    episodes = [],
    index = 0,
    allSources = [],
    probeResults = new Map(),
    currentSourceKey = "",
    resumeTime = 0,
    recordMeta = null,
    onStateChange,
    onMetaChange,
    onAdSkipState,
    onSourcePanelClose,
    onRouteBack,
    onExit,
    toast = defaultShowToast,
  }) {
    this.video = video;
    this.params = params;
    this.episodes = episodes;
    this.index = index;
    this.allSources = allSources;
    this.probeResults = probeResults;
    this.failedSourceKeys = new Set();
    this.currentSourceKey = currentSourceKey;
    this.resumeTime = Math.max(0, Number(resumeTime || 0));
    this.resumeApplied = false;
    this.recordMeta = recordMeta;
    this.lastSaveAt = 0;
    this.isExiting = false;
    this.playToken = 0;
    this.adSkip = initialAdSkipState();
    this.adScanAbort = null;
    this._proxiedForToken = 0;     // playToken of the stream currently routed via m3u8 proxy
    this._proxyKeepalive = null;   // cancel function for the keepalive poller
    this._directPlayUrl = "";      // unproxied URL of the current stream, for error fallback
    this.onStateChange = onStateChange;
    this.onMetaChange = onMetaChange;
    this.onAdSkipState = onAdSkipState;
    this.onSourcePanelClose = onSourcePanelClose;
    this.onRouteBack = onRouteBack;
    this.onExit = onExit;
    this.toast = toast;
  }

  _notifyState() {
    this.onStateChange?.(this);
  }

  _setAdSkip(state) {
    this.adSkip = state;
    this.onAdSkipState?.(state);
  }

  async playIndex(idx) {
    if (idx < 0 || idx >= this.episodes.length) return;
    const token = ++this.playToken;
    const switching = this.resumeApplied || idx !== this.index;
    if (switching) {
      this.saveRecord(true);
      this.resumeTime = 0;
      this.resumeApplied = false;
    }
    this.index = idx;
    this._notifyState();
    const rawUrl = this.episodes[idx];
    this._cancelAdScan();
    this._setAdSkip(initialAdSkipState());

    let playUrl = rawUrl;
    if (rawUrl && !this.isDirectMediaUrl(rawUrl)) {
      const source = this.currentSourceName();
      try {
        const result = await api.resolvePlayback(rawUrl, source);
        if (token !== this.playToken) return;
        if (result?.playbackUrl) playUrl = result.playbackUrl;
        else if (result?.resolvedUrl) playUrl = result.resolvedUrl;
        else {
          console.error("[DecoTV] resolvePlayback empty", { rawUrl, source, result });
          this.handlePlaybackError({
            sourceKey: this.currentSourceKey,
            sourceName: this.params?.sourceName || "",
            url: rawUrl,
            resolveEmpty: true,
          });
          return;
        }
      } catch (error) {
        if (token !== this.playToken) return;
        console.error("[DecoTV] resolvePlayback failed", {
          rawUrl,
          source,
          error: error?.message || error,
        });
        this.handlePlaybackError({
          sourceKey: this.currentSourceKey,
          sourceName: this.params?.sourceName || "",
          url: rawUrl,
          resolveError: error?.message || String(error),
        });
        return;
      }
    }

    // Proxy-first: route every HLS source through the on-device m3u8
    // ad-filter proxy from the very first playlist fetch. The proxy strips
    // dynamically-stitched ad segments (and passes clean playlists through
    // unchanged), so the player only ever sees a filtered, drift-invariant
    // timeline — no mid-play restart, no leaked head ads. Falls back to the
    // direct URL when the service is unavailable (non-webOS, bind failed).
    this._resetProxyState();
    this._directPlayUrl = playUrl;
    let effectiveUrl = playUrl;
    if (isHlsPlayUrl(playUrl) && !isLocalProxyUrl(playUrl)) {
      const port = await getM3u8ProxyPort();
      if (token !== this.playToken) return;
      if (port) {
        effectiveUrl = `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(playUrl)}`;
        this._proxiedForToken = token;
        this._startProxyKeepalive();
        console.info("[DecoTV] playing via m3u8 proxy", { port });
      } else {
        console.info("[DecoTV] m3u8 proxy unavailable, playing direct URL");
      }
    }

    this.video.src = effectiveUrl;
    this.video.load();
    const playPromise = this.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => { /* autoplay restriction — user must press play */ });
    }
    this.onMetaChange?.();
    this._startAdScan(effectiveUrl, token);
  }

  isDirectMediaUrl(url) {
    if (!url) return false;
    if (url.includes("/api/proxy/m3u8")) return true;
    return /\.(m3u8|mp4|m4v|webm|mkv|mov|flv)(\?|#|$)/i.test(url);
  }

  currentSourceName() {
    const source = this.allSources.find((item) => getSourceProbeKey(item) === this.currentSourceKey);
    return source?.source || this.currentSourceKey?.split("-")[0] || "";
  }

  _cancelAdScan() {
    if (this.adScanAbort) {
      try { this.adScanAbort.abort(); } catch (_) {}
      this.adScanAbort = null;
    }
  }

  // Proxy routing state is reset per playback (playIndex) and on cleanup —
  // NOT inside _cancelAdScan, which also runs when a scan restarts on a
  // stream that is already playing through the proxy.
  _resetProxyState() {
    this._stopProxyKeepalive();
    this._proxiedForToken = 0;
    this._directPlayUrl = "";
  }

  _startAdScan(playUrl, token) {
    if (!isHlsPlayUrl(playUrl)) return;
    this._cancelAdScan();
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.adScanAbort = controller;
    this._setAdSkip(markScanRunning(this.adSkip || initialAdSkipState()));
    const started = Date.now();
    scanAdRanges(playUrl, { signal: controller?.signal, concurrency: 2 })
      .then(async (result) => {
        if (token !== this.playToken) return;
        this._setAdSkip(applyScanResult(this.adSkip || initialAdSkipState(), result));
        if (result.dynamicStitched) {
          // Dynamic ad-stitching: ad positions drift between requests, so
          // the pre-scan ranges won't match what the player actually
          // downloads. Route the playlist through the on-device m3u8 proxy
          // instead — it rewrites each playlist on the fly to strip ad
          // segments before the player sees them.
          await this._switchToProxySource(playUrl, token);
        }
        console.info("[DecoTV] ad pre-scan", JSON.stringify({
          ranges: result.ranges?.length || 0,
          groups: result.groups,
          probed: result.probed,
          sigAdGroups: result.sigAdGroups || 0,
          elapsedMs: result.elapsedMs,
          baseline: result.baseline,
          dynamicStitched: result.dynamicStitched || false,
          proxied: result.dynamicStitched && this._proxiedForToken === token,
          wallMs: Date.now() - started,
        }));
      })
      .catch((error) => {
        if (token !== this.playToken) return;
        if (error?.name === "AbortError") return;
        this._setAdSkip(markScanFailed(this.adSkip || initialAdSkipState()));
        console.warn("[DecoTV] ad pre-scan failed", error?.message || error);
      })
      .finally(() => {
        if (this.adScanAbort === controller) this.adScanAbort = null;
      });
  }

  // Safety net: re-route a stream that started UNPROXIED (service was
  // unavailable at playIndex time) through the m3u8 proxy after the pre-scan
  // detects dynamic ad-stitching. When playback already started through the
  // proxy this never fires — the scanner sees the filtered playlist, which is
  // single-path by construction. Falls back to the original URL (with a
  // toast) if the service is still unavailable.
  async _switchToProxySource(originalUrl, token) {
    if (token !== this.playToken) return;
    if (this._proxiedForToken === token) return;
    const port = await getM3u8ProxyPort();
    if (!port || token !== this.playToken) {
      console.info("[DecoTV] m3u8 proxy unavailable, playing original URL");
      this.toast("广告过滤代理不可用，播放原始源", 3000);
      return;
    }
    // The proxy strips ad segments, which compresses the timeline. Map the
    // current position from the original timeline to the filtered timeline
    // by fetching the proxy's meta endpoint (returns removed ad ranges).
    const originalTime = this.video?.currentTime || 0;
    let resumeAt = originalTime;
    try {
      const metaUrl = `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(originalUrl)}&meta=1`;
      const r = await fetch(metaUrl);
      if (r.ok && token === this.playToken) {
        const meta = await r.json();
        const ranges = Array.isArray(meta.removedRanges) ? meta.removedRanges : [];
        // Subtract the overlap of each removed ad range with [0, originalTime].
        let removed = 0;
        for (const range of ranges) {
          if (range.end <= originalTime) removed += range.end - range.start;
          else if (range.start < originalTime) removed += originalTime - range.start;
        }
        resumeAt = Math.max(0, originalTime - removed);
      }
    } catch (_) {
      // Meta fetch failed — use originalTime as-is (slightly off but not fatal).
    }
    if (token !== this.playToken) return;
    const proxyUrl = `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(originalUrl)}`;
    this.video.src = proxyUrl;
    this.video.load();
    const playPromise = this.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => { /* autoplay restriction */ });
    }
    // Restore position once metadata loads for the proxied stream.
    const restoreOnce = () => {
      if (resumeAt > 0 && this.video.duration && resumeAt < this.video.duration - 5) {
        try { this.video.currentTime = resumeAt; } catch (_) {}
      }
      this.video?.removeEventListener("loadedmetadata", restoreOnce);
    };
    this.video?.addEventListener("loadedmetadata", restoreOnce);
    this._proxiedForToken = token;
    this._directPlayUrl = originalUrl;
    this._startProxyKeepalive();
    this.toast("已启用广告过滤代理", 2200);
    console.info("[DecoTV] switched to m3u8 proxy", { port, originalTime, resumeAt });
  }

  // Pin the dynamic service for the entire stream. webOS kills dynamic
  // services after ~10s idle, which would take the localhost m3u8 proxy down
  // mid-playback. Measured on-device: an open Luna subscription keeps the
  // Luna layer alive but NOT the HTTP server, so this is a 5s poll of
  // getM3u8ProxyPort (see subscribeKeepalive), not a subscription.
  _startProxyKeepalive() {
    this._stopProxyKeepalive();
    this._proxyKeepalive = subscribeKeepalive();
  }

  _stopProxyKeepalive() {
    if (this._proxyKeepalive) {
      try { this._proxyKeepalive(); } catch (_) {}
      this._proxyKeepalive = null;
    }
  }

  applyResume() {
    if (this.resumeApplied || !this.video) return;
    if (this.resumeTime <= 0) {
      this.resumeApplied = true;
      return;
    }
    const duration = this.video.duration || 0;
    if (!duration || !Number.isFinite(duration)) return;
    if (this.resumeTime < duration - 10) {
      try { this.video.currentTime = this.resumeTime; } catch (_) {}
      this.toast(`已从 ${formatTime(this.resumeTime)} 继续播放`);
    }
    this.resumeApplied = true;
  }

  saveRecord(force = false) {
    const video = this.video;
    if (!video || !this.recordMeta) return;
    const meta = this.recordMeta;
    if (!meta.title) return;
    const current = Math.floor(video.currentTime || 0);
    const duration = Math.floor(video.duration || 0);
    if (!force && current <= 0) return;
    this.lastSaveAt = Date.now();
    const key = LocalLibrary.recordKeyForTitle(meta.title, meta.year);
    const record = {
      title: meta.title,
      cover: meta.cover || "",
      source_name: meta.source_name || meta.source,
      source: meta.source || "",
      id: meta.id || "",
      year: meta.year || "",
      index: this.index + 1,
      total_episodes: meta.total_episodes || this.episodes.length,
      play_time: current,
      total_time: duration,
    };
    LocalLibrary.savePlayRecord(key, record);
    LibrarySync.pushRecord({ ...record, save_time: Date.now() });
  }

  handlePlaybackError(debug) {
    if (this.isExiting) return;
    // Proxied stream failed (service killed mid-play, port moved after a
    // rebind, upstream hiccup inside the proxy). Retry the same source
    // directly ONCE before blaming the source and failing over — worst case
    // the ads come back, but playback survives. Runs before the
    // failedSourceKeys.add below: a proxy failure is not the source's fault.
    if (this._proxiedForToken === this.playToken && this._directPlayUrl) {
      this._retryDirectAfterProxyError();
      return;
    }
    this.failedSourceKeys.add(this.currentSourceKey);
    const errorCode = this.video?.error?.code;
    const errorMap = { 1: "ABORTED", 2: "NETWORK", 3: "DECODE", 4: "SRC_NOT_SUPPORTED" };
    let errorLabel = errorMap[errorCode] || "";
    if (debug?.stalled) errorLabel = "STALL";
    if (!errorLabel) {
      if (debug?.resolveError) errorLabel = "RESOLVE_FAIL";
      else if (debug?.resolveEmpty) errorLabel = "RESOLVE_EMPTY";
      else errorLabel = "ERR";
    }
    const sourceName = debug?.sourceName || "?";
    const failedCount = this.failedSourceKeys.size;
    const total = this.allSources.length;
    console.error(`[DecoTV] ${errorLabel} on "${sourceName}" (${failedCount}/${total} failed)`, debug);
    const next = pickBestAvailableSource(this.allSources, this.probeResults, this.failedSourceKeys);
    if (next) {
      const key = getSourceProbeKey(next);
      this.toast(`${errorLabel} · ${sourceName} → 换源`);
      // After a failed load() the media element's currentTime is already 0,
      // so a chain of failovers loses the original position. Fall back to the
      // resumeTime set by the previous switchToSourceKey in the chain.
      const resumeAt = this.video?.currentTime || this.resumeTime || 0;
      this.switchToSourceKey(key, { resumeAt });
    } else {
      this.toast(`全部源不可用 · ${errorLabel}`);
      this.stopAndExit();
      this.onRouteBack?.();
    }
  }

  // Replay the current stream from its direct (unproxied) URL after a
  // proxied playback error. Single-shot per stream: _resetProxyState clears
  // the proxied flag, so a second error on the same stream goes down the
  // normal source-failover path.
  _retryDirectAfterProxyError() {
    const url = this._directPlayUrl;
    this._resetProxyState();
    const token = ++this.playToken;
    this._cancelAdScan();
    // After a failed load() the media element's currentTime is usually 0
    // already — fall back to the last known resume position. The proxied
    // timeline is compressed vs the direct one (ads removed), so this lands
    // slightly EARLIER on the direct timeline — the safe direction.
    const resumeAt = this.video?.currentTime || this.resumeTime || 0;
    this.resumeTime = resumeAt;
    this.resumeApplied = false;
    console.warn("[DecoTV] proxy playback failed, retrying direct", { resumeAt });
    this.toast("广告过滤代理失效，已切回原始源", 3000);
    this.video.src = url;
    this.video.load();
    const playPromise = this.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => { /* autoplay restriction */ });
    }
    this._startAdScan(url, token);
  }

  advanceOrExit() {
    if (this.index + 1 < this.episodes.length) {
      this.playIndex(this.index + 1);
    } else {
      this.stopAndExit();
      this.onRouteBack?.();
    }
  }

  switchToSourceKey(key, opts = {}) {
    const source = this.allSources.find((item) => getSourceProbeKey(item) === key);
    if (!source) return;
    if (key === this.currentSourceKey) {
      this.onSourcePanelClose?.();
      return;
    }
    const newEpisodes = Array.isArray(source.episodes) ? source.episodes : [];
    if (!newEpisodes.length) {
      this.toast("该源无剧集");
      return;
    }
    this.saveRecord(true);
    this.episodes = newEpisodes;
    this.currentSourceKey = key;
    this.params = {
      ...this.params,
      title: source.title || this.params?.title,
      sourceName: source.source_name || source.source,
    };
    if (this.recordMeta) {
      this.recordMeta = {
        ...this.recordMeta,
        source: source.source,
        id: source.id,
        source_name: source.source_name || source.source,
        title: source.title || this.recordMeta.title,
        cover: source.poster || this.recordMeta.cover,
        year: source.year || this.recordMeta.year,
        total_episodes: newEpisodes.length,
      };
    }
    this.index = Math.min(this.index, newEpisodes.length - 1);
    this.resumeTime = Math.max(0, Number(opts.resumeAt || 0));
    this.resumeApplied = false;
    this.onSourcePanelClose?.();
    this._notifyState();
    this.playIndex(this.index);
    this.onMetaChange?.();
    this.toast(`已切换到「${source.source_name || source.source}」`);
  }

  stopAndExit() {
    if (this.isExiting) return;
    this.isExiting = true;
    try { this.video?.pause(); } catch (_) {}
    this.saveRecord(true);
    this.onExit?.();
  }

  cleanup() {
    this._cancelAdScan();
    this._resetProxyState();
    this.saveRecord(true);
    try { this.video?.pause(); } catch (_) {}
  }
}
