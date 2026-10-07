import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressBack } from "../helpers/keys.mjs";

// A series listed season by season, with and without the space before the
// season, the way resource sites do. The playing source spells the current
// season without the space while the card spells it with one.
const hit = (title, id, eps = 3) => ({
  id: String(id), source: "s1", source_name: "源一", title, year: "2026", type_name: "剧集",
  // Local test media, like the shared fixtures: the probe marks s1 direct-playable.
  episodes: Array.from({ length: eps }, (_, i) => `http://127.0.0.1:4173/tests/e2e/assets/ep${(i % 2) + 1}.webm?s=${id}-${i + 1}`),
  episodes_titles: Array.from({ length: eps }, (_, i) => `第${i + 1}集`),
});
const SEASON6 = hit("系列测试第六季", 9006);
const SERIES = [hit("系列测试 第五季", 9005), hit("系列测试第五季", 9015, 5), hit("系列测试 第四季", 9004), SEASON6];

// Back is only handled once the player has mounted and started.
async function playThenBack(page) {
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });
  await page.waitForFunction(() => (document.getElementById("videoPlayer")?.currentTime || 0) > 0.3, null, { timeout: 10000 });
  // The first Back puts the bar away, the second leaves.
  await pressBack(page);
  await expect(page.locator("#playerControls")).toHaveClass(/hidden/);
  await pressBack(page);
  await page.waitForFunction(() => window.__router?.current === "detail");
}

test("series badges: one per season, current season excluded, still there after Back from the player", async ({ page }) => {
  const state = await bootToHome(page);
  // After boot, so these take precedence over the harness's /api/search mock.
  await page.route("**/api/search?**", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") || "";
    state.searchCalls.push(q);
    const results = q === "系列测试" ? SERIES : q === "系列测试 第六季" || q === "系列测试第六季" ? [SEASON6] : [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results }) });
  });

  await page.evaluate(() => window.__router.navigate("detail", { title: "系列测试 第六季", year: "2026", poster: "", autoPlay: true }));
  await playThenBack(page);

  const badges = page.locator("#detailRelatedBadges .chip");
  await expect(badges).toHaveText(["系列测试第五季", "系列测试 第四季"], { timeout: 10000 });
  // The keyword was the series base; nothing searched the season title as one word.
  expect(state.searchCalls).toContain("系列测试");
  expect(state.searchCalls).not.toContain("系列测试第六季");

  // A second round trip keeps them.
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "play");
  await press(page, "Enter");
  await playThenBack(page);
  await expect(badges).toHaveText(["系列测试第五季", "系列测试 第四季"]);
});
