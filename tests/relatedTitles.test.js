import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { relatedKeyword, filterRelatedResults, excludeRelated } from "../js/ui/screens/detail/relatedTitles.js";

const r = (title, eps = 1, year = "2020") => ({ title, year, episodes: Array.from({ length: eps }, () => "x") });

describe("related titles", () => {
  test("the keyword is the series base, whether or not the season is spaced", () => {
    assert.equal(relatedKeyword("某剧 第六季"), "某剧");
    assert.equal(relatedKeyword("某剧第六季"), "某剧");
    assert.equal(relatedKeyword("某剧第2季"), "某剧");
    assert.equal(relatedKeyword("某剧 Season 3"), "某剧");
    assert.equal(relatedKeyword("某剧 外传"), "某剧");
    assert.equal(relatedKeyword("某剧"), "某剧");
    assert.equal(relatedKeyword(""), "");
  });

  test("one badge per normalized title, the listing with most episodes", () => {
    const list = filterRelatedResults({ results: [
      r("某剧 第五季", 8), r("某剧第五季", 10), r("某剧 第四季", 10, "2018"), r("无关作品", 3),
    ] }, "某剧");
    assert.deepEqual(list.map((x) => x.title), ["某剧第五季", "某剧 第四季"]);
  });

  test("the work on screen is excluded under any spelling", () => {
    const list = [r("某剧第六季"), r("某剧 第五季")];
    assert.deepEqual(excludeRelated(list, ["某剧 第六季", undefined]).map((x) => x.title), ["某剧 第五季"]);
  });

  test("a far longer title sharing the prefix is not the series", () => {
    assert.deepEqual(filterRelatedResults({ results: [r("某剧之外的另一个完全不同的很长很长的作品名字")] }, "某剧"), []);
  });
});
