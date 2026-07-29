// tests/stallDetector.test.js — tests for frozen-playback detection.
// Run: node --test tests/stallDetector.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  initialStallState,
  nextStallState,
  isStalled,
  STALL_TIMEOUT_MS,
} from "../js/core/playback/stallDetector.js";

// Feed a series of [currentTime, now] observations through the fold.
function run(samples, base = {}) {
  let state = initialStallState();
  for (const [currentTime, now, extra] of samples) {
    state = nextStallState(state, {
      currentTime, now, paused: false, seeking: false, ended: false, ...base, ...extra,
    });
  }
  return state;
}

// The player ticks twice a second; mirror that in the fixtures.
function ticks(count, { from = 0, rate = 1, startNow = 0, stepMs = 500 } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push([from + (i * stepMs * rate) / 1000, startNow + i * stepMs]);
  }
  return out;
}

describe("normal playback never trips", () => {
  test("30s of 1x playback stays at zero", () => {
    const state = run(ticks(60));
    assert.equal(state.stalledMs, 0);
    assert.equal(isStalled(state), false);
  });

  test("2x playback stays at zero", () => {
    assert.equal(isStalled(run(ticks(60, { rate: 2 }))), false);
  });

  test("0.5x playback stays at zero", () => {
    assert.equal(isStalled(run(ticks(60, { rate: 0.5 }))), false);
  });
});

describe("frozen playback trips", () => {
  const frozen = (ms) => {
    const n = ms / 500 + 1;
    const out = [];
    for (let i = 0; i < n; i += 1) out.push([174.594, i * 500]);
    return out;
  };

  test("does not trip before the timeout", () => {
    assert.equal(isStalled(run(frozen(STALL_TIMEOUT_MS - 1000))), false);
  });

  test("trips once the timeout is reached", () => {
    const state = run(frozen(STALL_TIMEOUT_MS));
    assert.equal(state.stalledMs, STALL_TIMEOUT_MS);
    assert.equal(isStalled(state), true);
  });

  test("measures from the last forward progress, not from the first sample", () => {
    // 10s of healthy playback, then the clock sticks for the full timeout.
    const healthy = ticks(20);
    const stuck = [];
    for (let i = 1; i <= STALL_TIMEOUT_MS / 500; i += 1) stuck.push([9.5, 10000 + i * 500]);
    assert.equal(isStalled(run([...healthy, ...stuck])), true);
  });
});

describe("states that must never trip", () => {
  const longEnough = STALL_TIMEOUT_MS * 3;
  const held = (extra) => {
    const out = [];
    for (let i = 0; i <= longEnough / 500; i += 1) out.push([42, i * 500, extra]);
    return out;
  };

  test("paused for far longer than the timeout", () => {
    assert.equal(isStalled(run(held({ paused: true }))), false);
  });

  test("seeking", () => {
    assert.equal(isStalled(run(held({ seeking: true }))), false);
  });

  test("ended", () => {
    assert.equal(isStalled(run(held({ ended: true }))), false);
  });

  test("resuming after a long pause starts a fresh window", () => {
    const state = run([...held({ paused: true }), [42, longEnough + 500]]);
    assert.equal(state.stalledMs, 0);
  });
});

describe("seeks reset the window", () => {
  test("a forward jump clears accumulated stall time", () => {
    const stuck = [];
    for (let i = 0; i <= 16; i += 1) stuck.push([100, i * 500]); // 8s frozen
    const state = run([...stuck, [400, 9000]]);
    assert.equal(state.stalledMs, 0);
    assert.equal(state.anchorTime, 400);
  });

  test("a backward jump clears it too", () => {
    const stuck = [];
    for (let i = 0; i <= 16; i += 1) stuck.push([100, i * 500]);
    const state = run([...stuck, [20, 9000]]);
    assert.equal(state.stalledMs, 0);
    assert.equal(state.anchorTime, 20);
  });
});

describe("sub-frame jitter is not progress", () => {
  test("a few ms of drift still counts as frozen", () => {
    const out = [];
    for (let i = 0; i <= STALL_TIMEOUT_MS / 500; i += 1) {
      out.push([174.594 + (i % 2) * 0.004, i * 500]); // ±4ms wobble
    }
    assert.equal(isStalled(run(out)), true);
  });

  test("real progress just above the epsilon is respected", () => {
    const out = [];
    for (let i = 0; i <= STALL_TIMEOUT_MS / 500; i += 1) out.push([i * 0.06, i * 500]);
    assert.equal(isStalled(run(out)), false);
  });
});

describe("the incident this was written for", () => {
  // webOS froze at 174.594s with paused=false and error=null. The player ticked
  // for 17 minutes without noticing.
  test("the observed freeze is caught within the timeout", () => {
    let state = initialStallState();
    let tripped = null;
    for (let ms = 0; ms <= 17 * 60 * 1000; ms += 500) {
      state = nextStallState(state, {
        currentTime: 174.594, paused: false, seeking: false, ended: false, now: ms,
      });
      if (tripped === null && isStalled(state)) tripped = ms;
    }
    assert.equal(tripped, STALL_TIMEOUT_MS);
  });
});
