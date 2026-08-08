import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressUntilFocused } from "../helpers/keys.mjs";

test("player: restart button in the transport cluster seeks to 0, keeps playing", async ({ page }) => {
  await bootToHome(page);

  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "", autoPlay: true }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });

  // Let playback advance past the 2s mark so a restart visibly moves the clock.
  await page.waitForFunction(() => (document.getElementById("videoPlayer")?.currentTime || 0) > 2, null, { timeout: 10000 });

  // Down enters the button row; Right hops playPause -> nextEp -> restart.
  await press(page, "ArrowDown");
  await pressUntilFocused(page, "ArrowRight", '[data-ctrl="restart"]', 8);
  await press(page, "Enter");

  await page.waitForFunction(() => (document.getElementById("videoPlayer")?.currentTime || 0) < 1, null, { timeout: 5000 });
  // Keeps playing — not paused.
  expect(await page.evaluate(() => document.getElementById("videoPlayer")?.paused)).toBe(false);
});
