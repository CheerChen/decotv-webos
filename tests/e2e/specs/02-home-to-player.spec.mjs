import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press } from "../helpers/keys.mjs";

test("Enter on a home card auto-selects the best source and starts playback", async ({ page }) => {
  const state = await bootToHome(page);

  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });

  // Detail searched exactly once on the way through.
  expect(state.searchCalls).toEqual(["测试剧集"]);

  await expect(page.locator("#playerTitle")).toHaveText("测试剧集");
  await expect(page.locator("#playerSubtitle")).toContainText("源一");
  await expect(page.locator("#playerSubtitle")).toContainText("第 1 集");

  const src = await page.evaluate(() => document.getElementById("videoPlayer")?.src || "");
  expect(src).toContain("/tests/e2e/assets/ep1.webm");

  // The video really plays (autoplay flag is set in the config).
  await page.waitForFunction(
    () => (document.getElementById("videoPlayer")?.currentTime || 0) > 0.5,
    null,
    { timeout: 10000 }
  );
  await expect(page.locator("#playerControls")).not.toHaveClass(/hidden/);

  // Sentinel for the _tick regression: >= 2 tick cycles while playing, no errors.
  await page.waitForTimeout(1200);
  expect(state.errors).toEqual([]);
});
