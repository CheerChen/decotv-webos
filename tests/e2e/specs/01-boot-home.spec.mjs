import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";

test("boots a seeded session straight to home with focus on the first card", async ({ page }) => {
  const state = await bootToHome(page);

  expect(await page.evaluate(() => window.__router.current)).toBe("home");
  await expect(page.locator("#home")).toBeVisible();

  // Focus auto-upgrades from the nav tab to the first poster card.
  const focused = page.locator("#home .poster-card.focused");
  await expect(focused).toHaveAttribute("data-title", "测试剧集");
  await expect(focused).toHaveAttribute("data-action", "open-douban");

  // Boot must be clean of uncaught exceptions.
  expect(state.errors).toEqual([]);
});
