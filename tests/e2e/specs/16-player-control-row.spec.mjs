import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressUntilFocused } from "../helpers/keys.mjs";

const LIST = '[data-ctrl="episodePanel"]';
const SOURCES = '[data-ctrl="sourcePanel"]';

test("list and source buttons are icons; the list rows carry the official episode titles", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", {
    title: "测试剧集", year: "2024", poster: "", autoPlay: true, work: { provider: "tmdb", kind: "tv", id: "777" },
  }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });

  for (const [sel, label] of [[LIST, "剧集列表"], [SOURCES, "换源"]]) {
    const btn = page.locator(sel);
    await expect(btn).toHaveAttribute("aria-label", label);
    await expect(btn.locator("svg")).toHaveCount(1);
    await expect(btn).toHaveText("");
  }

  await press(page, "ArrowDown");
  await pressUntilFocused(page, "ArrowRight", LIST, 8);
  await press(page, "Enter");
  const rows = page.locator("#playerEpisodeList .player-side-item");
  await expect(rows).toHaveCount(3);
  // An official title leads, the number moves to the second line; the
  // placeholder name of episode 2 is no title, so its number stays.
  await expect(rows.nth(0).locator(".player-side-item-label")).toHaveText("E2E 第一夜");
  await expect(rows.nth(0).locator(".player-side-item-sub")).toHaveText("第 1 集 · 正在播放");
  await expect(rows.nth(1).locator(".player-side-item-label")).toHaveText("第 2 集");
  await expect(rows.nth(1).locator(".player-side-item-sub")).toHaveCount(0);
  await expect(rows.nth(2).locator(".player-side-item-label")).toHaveText("E2E 第三夜");
  await expect(rows.nth(2).locator(".player-side-item-sub")).toHaveText("第 3 集");
  await expect(rows.nth(0)).toHaveClass(/focused/);
});

test("a single video has no list button", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("player", {
    title: "单集片",
    year: "2024",
    sourceName: "源一",
    episodes: ["http://127.0.0.1:4173/tests/e2e/assets/ep1.webm"],
    index: 0,
  }));
  await page.waitForFunction(() => window.__router?.current === "player");
  await expect(page.locator('[data-ctrl="playPause"]')).toHaveCount(1);
  await expect(page.locator(LIST)).toHaveCount(0);
  await expect(page.locator(SOURCES)).toHaveCount(1);
});
