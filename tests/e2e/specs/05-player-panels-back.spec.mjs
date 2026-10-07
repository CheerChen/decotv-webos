import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressBack, pressUntilFocused } from "../helpers/keys.mjs";

test("player: source panel opens from controls; Back closes panel, then the bar, then exits", async ({ page }) => {
  await bootToHome(page);

  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "", autoPlay: true }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });

  // Controls start visible; Down moves focus zone progress -> buttons.
  await expect(page.locator("#playerControls")).not.toHaveClass(/hidden/);
  await press(page, "ArrowDown");
  await expect(page.locator(".player-control-btn.focused")).toHaveCount(1);

  await pressUntilFocused(page, "ArrowRight", '[data-ctrl="sourcePanel"]', 8);
  await press(page, "Enter");
  await expect(page.locator("#playerSourcePanel")).toBeVisible();
  await expect(page.locator("#playerSourceList .player-side-item")).toHaveCount(3);
  await expect(page.locator("#playerSourceList .player-side-item.selected")).toContainText("源一");

  // First Back is consumed by the panel — still on the player.
  await pressBack(page);
  await expect(page.locator("#playerSourcePanel")).toHaveCount(0);
  expect(await page.evaluate(() => window.__router.current)).toBe("player");

  // Second Back puts the bar away — still on the player.
  await expect(page.locator("#playerControls")).not.toHaveClass(/hidden/);
  await pressBack(page);
  await expect(page.locator("#playerControls")).toHaveClass(/hidden/);
  expect(await page.evaluate(() => window.__router.current)).toBe("player");

  // Third Back, with nothing on screen, exits to detail.
  await pressBack(page);
  await page.waitForFunction(() => window.__router?.current === "detail");
});
