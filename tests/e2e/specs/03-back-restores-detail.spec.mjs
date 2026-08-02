import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressBack } from "../helpers/keys.mjs";

test("Back from player restores detail from cache; Back again returns home", async ({ page }) => {
  const state = await bootToHome(page);

  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });

  await pressBack(page);
  await page.waitForFunction(() => window.__router?.current === "detail");

  // Restored from preferCache: no second /api/search, status shows the pick.
  expect(state.searchCalls).toEqual(["测试剧集"]);
  await expect(page.locator("#detailStatus")).toContainText("已选");
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "play");

  // fromHistory must NOT re-trigger autoplay back into the player.
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__router.current)).toBe("detail");

  await pressBack(page);
  await page.waitForFunction(() => window.__router?.current === "home");

  // Playback persisted a play record, so home now renders a 继续观看 row at
  // the top. Home does NOT restore the previous focus position across
  // remounts: it focuses the first poster card, which is now the history card.
  const focused = page.locator("#home .poster-card.focused");
  await expect(focused).toHaveAttribute("data-action", "open-rec");
  await expect(focused).toHaveAttribute("data-key", "测试剧集|2024");

  // Pin the persisted record itself (written by _stopAndExit -> _saveRecord).
  const records = await page.evaluate(() => JSON.parse(localStorage.getItem("decotv.local.playRecords") || "{}"));
  expect(Object.keys(records)).toContain("测试剧集|2024");
});
