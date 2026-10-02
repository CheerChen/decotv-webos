import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatVotes } from "../js/ui/utils.js";

describe("formatVotes", () => {
  test("exact under 100 (two significant digits already)", () => {
    assert.equal(formatVotes(3), "3");
    assert.equal(formatVotes(47), "47");
    assert.equal(formatVotes(99), "99");
  });

  test("floors to two significant digits with + under 1k", () => {
    assert.equal(formatVotes(263), "260+");
    assert.equal(formatVotes(532), "530+");
    assert.equal(formatVotes(999), "990+");
  });

  test("k units, floored to two significant digits", () => {
    assert.equal(formatVotes(1000), "1k");
    assert.equal(formatVotes(1758), "1.7k+");
    assert.equal(formatVotes(6421), "6.4k+");
    assert.equal(formatVotes(24310), "24k+");
    assert.equal(formatVotes(642100), "640k+");
    assert.equal(formatVotes(999999), "990k+");
  });

  test("M units at/above 1M", () => {
    assert.equal(formatVotes(3247891), "3.2M+");
    assert.equal(formatVotes(12570000), "12M+");
    assert.equal(formatVotes(125000000), "120M+");
  });

  test("exact values get no +", () => {
    assert.equal(formatVotes(10000), "10k");
    assert.equal(formatVotes(500000), "500k");
    assert.equal(formatVotes(3000000), "3M");
  });

  test("degenerate inputs", () => {
    assert.equal(formatVotes(0), "");
    assert.equal(formatVotes(-5), "");
    assert.equal(formatVotes(undefined), "");
    assert.equal(formatVotes("abc"), "");
  });
});
