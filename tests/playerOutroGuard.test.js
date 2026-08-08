// playerOutroGuard.test.js — the outro one-shot guard must re-arm for every
// episode load, not just the first one mounted in a player session.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PlayerScreen } from "../js/ui/screens/player/playerScreen.js";

// showToast() no-ops when the toast element is missing.
globalThis.document = { getElementById: () => null };

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

class FakeVideo {
  constructor() {
    this.currentTime = 0;
    this.duration = 1200;
    this.paused = false;
    this.seeking = false;
    this.ended = false;
    this._handlers = {};
  }
  addEventListener(ev, fn) {
    (this._handlers[ev] ||= []).push(fn);
  }
  removeEventListener(ev, fn) {
    this._handlers[ev] = (this._handlers[ev] || []).filter((h) => h !== fn);
  }
  dispatch(ev) {
    for (const fn of this._handlers[ev] || []) fn();
  }
}

function mountScreen() {
  PlayerScreen.episodes = ["e0", "e1", "e2"];
  PlayerScreen.index = 0;
  PlayerScreen.paused = false;
  PlayerScreen._isExiting = false;
  PlayerScreen._outroTriggered = false;
  PlayerScreen.container = { querySelector: () => null };
  PlayerScreen._listeners = [];
  PlayerScreen.video = new FakeVideo();
  // Real flow: playIndex resolves the URL (async gap, old timeline still
  // visible and the guard armed) before setting src + load(), which fires
  // loadstart and starts the next episode's timeline.
  PlayerScreen.playback = {
    playIndex: async (idx) => {
      PlayerScreen.index = idx;
      await flush();
      PlayerScreen.video.dispatch("loadstart");
    },
  };
  PlayerScreen._getOutroMark = () => ({ fromEnd: 30 });
  PlayerScreen._bindVideo();
}

describe("outro one-shot guard lifecycle", () => {
  test("auto-advances once per episode, re-armed by each media load", async () => {
    mountScreen();

    // Episode 1 reaches the outro point (duration 1200, mark fromEnd 30).
    PlayerScreen.video.currentTime = 1170;
    PlayerScreen._checkOutroMark(PlayerScreen.video);
    assert.equal(PlayerScreen.index, 1, "first episode auto-advances");
    assert.equal(PlayerScreen._outroTriggered, true, "guard armed after trigger");

    // A tick while the old timeline is still visible (resolve in flight)
    // must not double-advance: the guard holds until the new load.
    PlayerScreen.video.currentTime = 1180;
    PlayerScreen._checkOutroMark(PlayerScreen.video);
    assert.equal(PlayerScreen.index, 1, "no double-advance during switch");

    // The next episode's media load re-arms the guard.
    await flush();
    assert.equal(PlayerScreen._outroTriggered, false, "guard re-armed on load");

    // Episode 2 reaches its own outro point and must advance again.
    PlayerScreen.video.currentTime = 1170;
    PlayerScreen._checkOutroMark(PlayerScreen.video);
    assert.equal(PlayerScreen.index, 2, "second episode auto-advances");
  });
});
