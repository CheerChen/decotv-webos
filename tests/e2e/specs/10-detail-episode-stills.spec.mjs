import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press } from "../helpers/keys.mjs";

test("a TMDB tv work shows episode cards with stills and official titles; Enter plays the episode", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", {
    title: "测试剧集", year: "2024", poster: "", work: { provider: "tmdb", kind: "tv", id: "777" },
  }));

  const cards = page.locator("#episodesList.stills .episode-card");
  await expect(cards).toHaveCount(3, { timeout: 10000 });
  // Still where TMDB has one, a blank face where it has none.
  await expect(cards.nth(0).locator("img.episode-still")).toHaveCount(1);
  await expect(cards.nth(1).locator(".episode-still.blank")).toHaveCount(1);
  // Official names; the placeholder "第 2 集" name is no title.
  await expect(cards.nth(0).locator(".episode-card-title")).toHaveText("E2E 第一夜");
  await expect(cards.nth(1).locator(".episode-card-title")).toHaveCount(0);
  await expect(cards.nth(2).locator(".episode-card-title")).toHaveText("E2E 第三夜");
  await expect(page.locator("#detailTags")).toContainText("TMDB 8.0");

  // The rail is reachable from play and plays the picked episode.
  await expect(page.locator("#detail .focused")).toHaveAttribute("data-action", "play");
  await press(page, "ArrowDown");
  await expect(page.locator("#detail .focused")).toHaveClass(/episode-card/);
  await press(page, "ArrowRight");
  const idx = await page.locator("#detail .focused").getAttribute("data-index");
  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "player");
  await expect(page.locator("#playerSubtitle")).toContainText(`第 ${Number(idx) + 1} 集`);
});

test("a douban work keeps the text episode buttons", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", {
    title: "测试剧集", year: "2024", poster: "", work: { provider: "douban", kind: "movie", id: "1001" },
  }));
  await expect(page.locator("#episodesList .episode-item")).toHaveCount(3, { timeout: 10000 });
  await expect(page.locator("#episodesList .episode-card")).toHaveCount(0);
});

test("a Bangumi work shows title cards without an image area", async ({ page }) => {
  await bootToHome(page);
  // Registered after boot so they take precedence over the harness's
  // blanket api.bgm.tv abort.
  await page.route("https://api.bgm.tv/v0/subjects/555", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 555, name_cn: "测试剧集", date: "2024-01-01", rating: { score: 7.2, total: 800 }, meta_tags: [], infobox: [] }),
  }));
  await page.route("https://api.bgm.tv/v0/episodes?**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: [
      { type: 0, name_cn: "E2E 话一", name: "" },
      { type: 0, name_cn: "", name: "E2E Original Two" },
      { type: 0, name_cn: "E2E 话三" },
    ] }),
  }));
  await page.evaluate(() => window.__router.navigate("detail", {
    title: "测试剧集", year: "2024", poster: "", work: { provider: "bangumi", kind: "", id: "555" },
  }));
  const cards = page.locator("#episodesList.stills .episode-card");
  await expect(cards).toHaveCount(3, { timeout: 10000 });
  await expect(page.locator("#episodesList .episode-still")).toHaveCount(0);
  await expect(cards.nth(1).locator(".episode-card-title")).toHaveText("E2E Original Two");
  await expect(page.locator("#detailTags")).toContainText("Bangumi 7.2");
});
