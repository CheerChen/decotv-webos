// outroMark.test.js — pure outro timeline rules.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  outroMarkKey,
  isValidOutroMark,
  getOutroFromEnd,
  outroMarkerPercent,
  shouldTriggerOutro,
} from "../js/core/playback/outroMark.js";

describe("outro mark keys", () => {
  test("uses the same title|year key as play records", () => {
    assert.equal(outroMarkKey("  Show  ", " 2024 "), "Show|2024");
    assert.equal(outroMarkKey("Show", ""), "Show");
    assert.equal(outroMarkKey("", "2024"), "");
  });
});

describe("outro mark validity", () => {
  test("accepts marks at least one second from the end and in the final half", () => {
    assert.equal(isValidOutroMark({ fromEnd: 10 }, 100), true);
    assert.equal(isValidOutroMark({ fromEnd: 50 }, 100), true);
    assert.equal(isValidOutroMark({ fromEnd: 0.9 }, 100), false);
    assert.equal(isValidOutroMark({ fromEnd: 51 }, 100), false);
  });

  test("rejects non-finite or unusable durations", () => {
    assert.equal(isValidOutroMark({ fromEnd: 10 }, 0), false);
    assert.equal(isValidOutroMark({ fromEnd: 10 }, Infinity), false);
    assert.equal(isValidOutroMark({ fromEnd: "nope" }, 100), false);
  });

  test("derives a valid from-end value from the current position", () => {
    assert.equal(getOutroFromEnd(90, 100), 10);
    assert.equal(getOutroFromEnd(99.5, 100), null);
    assert.equal(getOutroFromEnd(40, 100), null);
  });

  test("maps a valid mark to the progress-bar percentage", () => {
    assert.equal(outroMarkerPercent({ fromEnd: 10 }, 100), 90);
    assert.equal(outroMarkerPercent({ fromEnd: 50 }, 100), 50);
    assert.equal(outroMarkerPercent({ fromEnd: 60 }, 100), null);
  });
});

describe("outro trigger", () => {
  const base = {
    episodesLength: 3,
    index: 0,
    paused: false,
    seeking: false,
    ended: false,
    currentTime: 91,
    duration: 100,
    mark: { fromEnd: 10 },
  };

  test("triggers at the marked timeline position", () => {
    assert.equal(shouldTriggerOutro(base), true);
    assert.equal(shouldTriggerOutro({ ...base, currentTime: 89 }), false);
  });

  test("does not trigger for terminal or inactive playback states", () => {
    for (const patch of [
      { index: 2 },
      { episodesLength: 1 },
      { paused: true },
      { seeking: true },
      { ended: true },
      { isExiting: true },
      { outroTriggered: true },
      { mark: null },
    ]) {
      assert.equal(shouldTriggerOutro({ ...base, ...patch }), false);
    }
  });
});
