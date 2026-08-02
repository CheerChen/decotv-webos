import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";

test("resolve failure on the best source fails over to the next source", async ({ page }) => {
  const state = await bootToHome(page);

  await page.evaluate(() => window.__router.navigate("detail", { title: "故障剧", year: "2023", poster: "", autoPlay: true }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });

  // Failover lands on the good source and plays its file directly.
  await expect(page.locator("#playerSubtitle")).toContainText("好源", { timeout: 10000 });
  const src = await page.evaluate(() => document.getElementById("videoPlayer")?.src || "");
  expect(src).toContain("ep1.webm");

  // The bad source went through /api/playback/resolve and got the 500.
  expect(state.resolveCalls).toContain("f1");
  expect(await page.evaluate(() => window.__router.current)).toBe("player");
});
