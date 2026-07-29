// stallDetector.js — detect playback that claims to be running but is not.
//
// Some failures never reach the `error` event. A resource site's playlist can
// wedge the platform HLS demuxer so that <video> keeps reporting paused=false,
// error=null and networkState=LOADING while currentTime never moves again. The
// picture is frozen, nothing is logged, and the player's own failover never
// runs because no error was raised. Watching the clock is the only way to see
// it (observed on webOS 10.3: a playlist whose ad segments were removed without
// an EXT-X-DISCONTINUITY marker froze at the splice point for 17 minutes).
//
// The state is threaded through explicitly rather than held in a closure so the
// whole thing stays a pure function and can be tested without a media element.

export const STALL_TIMEOUT_MS = 10000;

// currentTime is a float that can jitter by a few ms while a frame is held.
// Require more than that before calling it progress.
const PROGRESS_EPSILON = 0.05;

export function initialStallState() {
  return { anchorTime: null, anchorAt: 0, stalledMs: 0 };
}

// Fold one observation into the state. `sample` mirrors the media element:
// { currentTime, paused, seeking, ended, now }.
//
// Only playback that is *supposed* to be advancing can stall, so pausing,
// seeking or reaching the end resets the anchor instead of accumulating time.
// A backwards jump is a seek the caller did not flag, and also resets.
export function nextStallState(state, sample) {
  const { currentTime, paused, seeking, ended, now } = sample;
  if (paused || seeking || ended) return initialStallState();

  const noAnchor = state.anchorTime === null;
  const movedForward = !noAnchor && currentTime > state.anchorTime + PROGRESS_EPSILON;
  const movedBackward = !noAnchor && currentTime < state.anchorTime - PROGRESS_EPSILON;
  if (noAnchor || movedForward || movedBackward) {
    return { anchorTime: currentTime, anchorAt: now, stalledMs: 0 };
  }

  return { anchorTime: state.anchorTime, anchorAt: state.anchorAt, stalledMs: now - state.anchorAt };
}

export function isStalled(state, timeoutMs = STALL_TIMEOUT_MS) {
  return state.stalledMs >= timeoutMs;
}
