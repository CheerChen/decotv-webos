// playbackSwitch.test.js — the position a source switch resumes at.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PlaybackController } from "../js/ui/screens/player/playbackController.js";

const playhead = (state) => PlaybackController.prototype.playheadForSwitch.call(state);

describe("source switch position", () => {
  test("a playing episode switches at the element's clock", () => {
    assert.equal(playhead({ video: { currentTime: 600 }, resumeApplied: true, resumeTime: 30 }), 600);
    // Restarted to 0 (resume applied): 0 is the viewer's position.
    assert.equal(playhead({ video: { currentTime: 0 }, resumeApplied: true, resumeTime: 30 }), 0);
  });

  test("before this load's resume is applied, the pending resume position wins", () => {
    // A failed load() reset the clock to 0: a chain of failovers keeps the position.
    assert.equal(playhead({ video: { currentTime: 0 }, resumeApplied: false, resumeTime: 600 }), 600);
    assert.equal(playhead({ video: null, resumeApplied: false, resumeTime: 600 }), 600);
    assert.equal(playhead({ video: { currentTime: NaN }, resumeApplied: false, resumeTime: 0 }), 0);
  });
});
