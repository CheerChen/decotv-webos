import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press, pressUntilFocused } from "../helpers/keys.mjs";

const MARK = '[data-ctrl="skipMark"]';

// Paused, so the controls stay up and the playhead stays where it is put.
async function openPausedAt(page, seconds) {
  await page.evaluate((t) => {
    const v = document.getElementById("videoPlayer");
    v.pause();
    v.currentTime = t;
  }, seconds);
}

async function startShow(page) {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "", autoPlay: true }));
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });
  await page.waitForFunction(() => (document.getElementById("videoPlayer")?.duration || 0) > 0, null, { timeout: 10000 });
}

test("mark button: the second half marks the outro, and clears it from before the mark", async ({ page }) => {
  await startShow(page);
  await openPausedAt(page, 7);

  await press(page, "ArrowDown");
  await pressUntilFocused(page, "ArrowRight", MARK, 10);
  const btn = page.locator(MARK);
  await expect(btn).toHaveAttribute("data-state", "outro-unmarked");
  await expect(btn).toHaveAttribute("aria-label", "标记片尾");
  // Icon only: no visible text.
  await expect(btn).toHaveText("");

  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已标记片尾");
  await expect(btn).toHaveAttribute("data-state", "outro-marked");
  await expect(btn).toHaveAttribute("aria-label", "取消片头片尾标记");
  await expect(btn).toHaveClass(/active/);
  await expect(page.locator("#playerProgressOutro")).toBeVisible();

  // Before the outro point (marked at 7 s): still the outro's half, so the
  // same button clears it.
  await openPausedAt(page, 6);
  await expect(btn).toHaveAttribute("data-state", "outro-marked");
  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已取消片头片尾标记");
  await expect(btn).toHaveAttribute("data-state", "outro-unmarked");
  await expect(page.locator("#playerProgressOutro")).toBeHidden();
  // Updated in place: focus never left the button.
  await expect(btn).toHaveClass(/focused/);
});

test("mark button: marks both halves, the next episode starts past the intro, one press clears both", async ({ page }) => {
  await startShow(page);
  await openPausedAt(page, 3);

  await press(page, "ArrowDown");
  await pressUntilFocused(page, "ArrowRight", MARK, 10);
  const btn = page.locator(MARK);
  await expect(btn).toHaveAttribute("data-state", "intro-unmarked");
  await expect(btn).toHaveAttribute("aria-label", "标记片头");

  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已标记片头");
  await expect(btn).toHaveAttribute("data-state", "intro-marked");
  await expect(page.locator("#playerProgressIntro")).toBeVisible();

  // The outro's half is still unmarked: the same button marks it.
  await openPausedAt(page, 8);
  await expect(btn).toHaveAttribute("data-state", "outro-unmarked");
  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已标记片尾");
  await expect(page.locator("#playerProgressOutro")).toBeVisible();

  await pressUntilFocused(page, "ArrowLeft", '[data-ctrl="nextEp"]', 10);
  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已跳过片头");
  await page.waitForFunction(() => {
    const v = document.getElementById("videoPlayer");
    return v && v.currentTime >= 3 && v.currentTime < 5;
  }, null, { timeout: 5000 });

  // From the intro's half, one press clears the outro mark too.
  await openPausedAt(page, 1);
  await pressUntilFocused(page, "ArrowRight", MARK, 10);
  await expect(btn).toHaveAttribute("data-state", "intro-marked");
  await press(page, "Enter");
  await expect(page.locator("#toast")).toContainText("已取消片头片尾标记");
  await expect(page.locator("#playerProgressIntro")).toBeHidden();
  await expect(page.locator("#playerProgressOutro")).toBeHidden();
  await openPausedAt(page, 8);
  await expect(btn).toHaveAttribute("data-state", "outro-unmarked");
});

test("mark button: not shown when there are no episodes to skip between", async ({ page }) => {
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
  await expect(page.locator(MARK)).toHaveCount(0);
});
