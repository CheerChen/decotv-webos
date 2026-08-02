import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press } from "../helpers/keys.mjs";

test("detail without autoplay: ranked sources, favorite toggle, episode Enter plays", async ({ page }) => {
  await bootToHome(page);

  // Deep-link WITHOUT autoPlay so the screen stays on detail.
  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "" }));
  await page.waitForFunction(() => document.querySelectorAll("#sourceList .source-row").length === 3);
  await expect(page.locator("#detailStatus")).toContainText("已选", { timeout: 10000 });

  // Ranked order: verified 1080p first, failed source last.
  const rows = page.locator("#sourceList .source-row");
  await expect(rows.nth(0)).toHaveAttribute("data-key", "s1-101");
  await expect(rows.nth(0).locator(".probe-ok")).toContainText("1080p");
  await expect(rows.nth(2).locator(".probe-failed")).toBeVisible();

  // Episode grid appears once the probe loop ends.
  await expect(page.locator("#episodesList .episode-item")).toHaveCount(3);

  // Initial focus is the play button; Right reaches favorite (measured hop).
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "play");
  await press(page, "ArrowRight");
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "favorite");
  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已收藏");
  const favs = await page.evaluate(() => JSON.parse(localStorage.getItem("decotv.local.favorites") || "{}"));
  expect(Object.keys(favs)).toContain("s1+101");
  // Toggling must not drop the focus ring.
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "favorite");

  // Measured focus topology (Rev 3): from favorite, Down skips the episode
  // grid entirely (no horizontal overlap) and lands on the source list.
  // The episode grid is only reachable from the play button, and Down from
  // play lands on episode index 2 (geometrically nearest column).
  await press(page, "ArrowLeft");
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "play");
  await press(page, "ArrowDown");
  const ep = page.locator("#detail .focused");
  await expect(ep).toHaveAttribute("data-action", "play-ep");
  await expect(ep).toHaveAttribute("data-index", "2");
  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "player");
  await expect(page.locator("#playerSubtitle")).toContainText("源一");
  await expect(page.locator("#playerSubtitle")).toContainText("第 3 集");
});
