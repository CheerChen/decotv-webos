import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press } from "../helpers/keys.mjs";

test("detail with no sources anywhere: retries spaced queries, then offers back instead of play", async ({ page }) => {
  const state = await bootToHome(page);

  // A spaced title no catalog fixture carries.
  await page.evaluate(() => window.__router.navigate("detail", { title: "无此作品 第二季", year: "2024", poster: "" }));
  await expect(page.locator("#detailStatus")).toContainText("没有找到可播放的资源", { timeout: 10000 });

  // The title first, then joined, then its head (the related-series badges
  // may also search the head, so only order and presence are fixed here).
  expect(state.searchCalls[0]).toBe("无此作品 第二季");
  expect(state.searchCalls).toContain("无此作品第二季");
  expect(state.searchCalls).toContain("无此作品");
  expect(state.searchCalls.indexOf("无此作品第二季")).toBeLessThan(state.searchCalls.lastIndexOf("无此作品"));

  // The dead actions are gone; the way out holds focus.
  await expect(page.locator('#detail [data-action="play"]')).toHaveCount(0);
  await expect(page.locator('#detail [data-action="refresh"]')).toHaveCount(0);
  const focused = page.locator("#detail .focused");
  await expect(focused).toHaveAttribute("data-action", "back");
  await expect(focused).toHaveText("返回");

  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "home");
});
