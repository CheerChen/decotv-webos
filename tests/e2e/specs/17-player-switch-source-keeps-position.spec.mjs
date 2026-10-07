import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressUntilFocused } from "../helpers/keys.mjs";

test("switching source from the panel keeps the episode and the position", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", { title: "长剧", year: "2025", poster: "", autoPlay: true }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });
  await expect(page.locator("#playerSubtitle")).toContainText("长源一", { timeout: 10000 });
  await page.waitForFunction(() => (document.getElementById("videoPlayer")?.duration || 0) > 0, null, { timeout: 10000 });

  await page.evaluate(() => {
    const v = document.getElementById("videoPlayer");
    v.pause();
    v.currentTime = 30;
  });

  await press(page, "ArrowDown");
  await pressUntilFocused(page, "ArrowRight", '[data-ctrl="sourcePanel"]', 10);
  await press(page, "Enter");
  await expect(page.locator("#playerSourcePanel")).toBeVisible();
  await pressUntilFocused(page, "ArrowDown", '[data-panel-source-key="l2-1102"]', 5);
  // Count the NEW stream's metadata: both sources resolve to the same file,
  // so the old and the new stream differ only by load.
  await page.evaluate(() => {
    window.__newLoads = 0;
    document.getElementById("videoPlayer").addEventListener("loadedmetadata", () => { window.__newLoads += 1; });
  });
  await press(page, "Enter");

  // l2 resolves 1.5 s late: the old stream sits in the element meanwhile,
  // and the resume must wait for the new one (the app's own loadedmetadata
  // handler runs first and seeks).
  await expect(page.locator("#playerSubtitle")).toContainText("长源二");
  await page.waitForFunction(() => window.__newLoads >= 1, null, { timeout: 8000 });
  await expect(page.locator("#toast")).toContainText("已从 0:30 继续播放");
  const t = await page.evaluate(() => document.getElementById("videoPlayer").currentTime);
  expect(t).toBeGreaterThanOrEqual(29.5);
  // Still the same episode.
  await expect(page.locator("#playerSubtitle")).toContainText("第 1 集");
});
