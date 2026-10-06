// skipMarks.test.js — pure intro/outro timeline rules.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  skipMarkKey,
  isValidOutroMark,
  isValidIntroMark,
  getOutroFromEnd,
  getIntroEnd,
  outroMarkerPercent,
  introMarkerPercent,
  markButtonAction,
  shouldTriggerOutro,
  shouldSkipIntro,
} from "../js/core/playback/skipMarks.js";

describe("skip mark keys", () => {
  test("uses the same title|year key as play records", () => {
    assert.equal(skipMarkKey("  Show  ", " 2024 "), "Show|2024");
    assert.equal(skipMarkKey("Show", ""), "Show");
    assert.equal(skipMarkKey("", "2024"), "");
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

describe("intro mark validity", () => {
  test("accepts marks at least one second in and in the first half", () => {
    assert.equal(isValidIntroMark({ introEnd: 10 }, 100), true);
    assert.equal(isValidIntroMark({ introEnd: 50 }, 100), true);
    assert.equal(isValidIntroMark({ introEnd: 0.9 }, 100), false);
    assert.equal(isValidIntroMark({ introEnd: 51 }, 100), false);
    // An outro-only record carries no intro mark.
    assert.equal(isValidIntroMark({ fromEnd: 10 }, 100), false);
    assert.equal(isValidIntroMark({ introEnd: 10 }, NaN), false);
  });

  test("derives the intro end from the current position", () => {
    assert.equal(getIntroEnd(12, 100), 12);
    assert.equal(getIntroEnd(0.5, 100), null);
    assert.equal(getIntroEnd(60, 100), null);
  });

  test("maps a valid mark to the progress-bar percentage", () => {
    assert.equal(introMarkerPercent({ introEnd: 10 }, 100), 10);
    assert.equal(introMarkerPercent({ introEnd: 60 }, 100), null);
  });
});

describe("mark button action", () => {
  const both = { introEnd: 10, fromEnd: 10 };

  test("the first half is the intro's, the second half the outro's", () => {
    assert.deepEqual(markButtonAction(null, 20, 100), { half: "intro", marked: false });
    assert.deepEqual(markButtonAction(null, 49.9, 100), { half: "intro", marked: false });
    assert.deepEqual(markButtonAction(null, 50, 100), { half: "outro", marked: false });
    assert.deepEqual(markButtonAction(null, 95, 100), { half: "outro", marked: false });
  });

  test("a marked half clears from anywhere in it, not only past the mark", () => {
    // Before the outro point: this is where the old toggle re-marked
    // instead of clearing, and past it auto-advance had already fired.
    assert.deepEqual(markButtonAction(both, 60, 100), { half: "outro", marked: true });
    assert.deepEqual(markButtonAction(both, 95, 100), { half: "outro", marked: true });
    assert.deepEqual(markButtonAction(both, 5, 100), { half: "intro", marked: true });
    assert.deepEqual(markButtonAction(both, 40, 100), { half: "intro", marked: true });
  });

  test("each half only sees its own mark", () => {
    assert.deepEqual(markButtonAction({ fromEnd: 10 }, 20, 100), { half: "intro", marked: false });
    assert.deepEqual(markButtonAction({ introEnd: 10 }, 80, 100), { half: "outro", marked: false });
  });

  test("a mark that does not fit this episode's length counts as unmarked", () => {
    assert.deepEqual(markButtonAction({ fromEnd: 70 }, 80, 100), { half: "outro", marked: false });
  });

  test("unknown duration is the intro half", () => {
    assert.deepEqual(markButtonAction(both, 0, NaN), { half: "intro", marked: false });
  });
});

describe("intro skip", () => {
  const base = { episodesLength: 3, currentTime: 0, duration: 100, mark: { introEnd: 10 } };

  test("skips on every episode, the last included, while before the mark", () => {
    assert.equal(shouldSkipIntro(base), true);
    assert.equal(shouldSkipIntro({ ...base, currentTime: 9 }), true);
    // shouldSkipIntro has no index input: the last episode skips too.
    assert.equal(shouldSkipIntro({ ...base, episodesLength: 2 }), true);
  });

  test("does not skip past the mark, for single videos, or without a valid mark", () => {
    for (const patch of [
      { currentTime: 10 },
      { currentTime: 30 },
      { episodesLength: 1 },
      { isExiting: true },
      { mark: null },
      { mark: { fromEnd: 10 } },
      { mark: { introEnd: 60 } },
    ]) {
      assert.equal(shouldSkipIntro({ ...base, ...patch }), false);
    }
  });
});
