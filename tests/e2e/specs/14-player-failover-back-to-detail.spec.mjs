import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { pressBack } from "../helpers/keys.mjs";

test("Back after a player failover: detail picks the source that played and marks the failed one", async ({ page }) => {
  await bootToHome(page);

  await page.evaluate(() => window.__router.navigate("detail", { title: "故障剧", year: "2023", poster: "", autoPlay: true }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });
  await expect(page.locator("#playerSubtitle")).toContainText("好源", { timeout: 10000 });

  await pressBack(page);
  await page.waitForFunction(() => window.__router?.current === "detail");

  // The pick is the source the player ended on, not detail's own best.
  await expect(page.locator("#detailStatus")).toContainText("已选「好源」");
  await expect(page.locator('#sourceList .source-row.current')).toHaveAttribute("data-key", "f2-902");

  // The failed source carries the playback mark; its probe metrics stay.
  const bad = page.locator('#sourceList .source-row[data-key="f1-901"]');
  await expect(bad.locator("[data-play-failed]")).toHaveText("播放失败");
  await expect(bad.locator(".source-row-probe .probe-ok")).toHaveCount(1);
  await expect(page.locator('#sourceList .source-row[data-key="f2-902"] [data-play-failed]')).toHaveCount(0);
});
