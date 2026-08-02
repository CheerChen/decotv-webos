// probeLabel.test.js — shared probe-result presentation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  probeLabel,
  renderProbeCell,
  renderProbeLine,
} from "../js/ui/probeLabel.js";

describe("probe labels", () => {
  test("renders pending results for cell and player contexts", () => {
    assert.deepEqual(probeLabel(null), {
      className: "probe-pending",
      symbol: "",
      text: "未测速",
    });
    assert.match(renderProbeCell(null), /probe-pending/);
    assert.equal(renderProbeLine(null), "未测速");
  });

  test("formats failed results with the failure marker", () => {
    const result = { status: "failed", message: "network down" };
    assert.deepEqual(probeLabel(result).symbol, "✕");
    assert.match(renderProbeCell(result), /probe-failed/);
    assert.match(renderProbeLine(result), /network down/);
  });

  test("formats verified quality, throughput, and ping", () => {
    const result = { status: "ok", playable: true, quality: "1080p", speedKBps: 2048, pingTime: 12 };
    assert.equal(probeLabel(result).text, "1080p · 2.00 MB/s · 12 ms");
    assert.match(renderProbeCell(result), /probe-ok/);
    assert.match(renderProbeLine(result), /2\.00 MB\/s/);
  });

  test("keeps partial results distinguishable", () => {
    const result = { status: "partial", playable: true, message: "fragment fallback" };
    assert.equal(probeLabel(result).className, "probe-partial");
    assert.match(renderProbeCell(result), /probe-partial/);
  });
});
