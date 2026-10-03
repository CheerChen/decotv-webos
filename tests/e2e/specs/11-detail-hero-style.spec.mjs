import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";

const TMDB_WORK = { provider: "tmdb", kind: "tv", id: "777" };

test("default hero keeps the portrait poster and asks for no photo wall", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "", work: { provider: "douban", kind: "movie", id: "1001" } }));
  await expect(page.locator("#detailTags")).toContainText("豆瓣 8.5", { timeout: 10000 });
  await expect(page.locator("#detailHero")).not.toHaveClass(/has-backdrop/);
  await expect(page.locator("#detailPoster")).toBeVisible();
  const paths = await page.evaluate(() => window.__doubanPaths || []);
  expect(paths.some((p) => p.includes("/rexxar/api/v2/movie/1001"))).toBe(true);
  expect(paths.filter((p) => p.includes("/photos"))).toEqual([]);
});

test("landscape hero on a douban work asks for its photo wall", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => localStorage.setItem("decotv.detailHero", JSON.stringify("backdrop")));
  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "", work: { provider: "douban", kind: "movie", id: "1001" } }));
  await expect(page.locator("#detailTags")).toContainText("豆瓣 8.5", { timeout: 10000 });
  await page.waitForFunction(() => (window.__doubanPaths || []).some((p) => p.includes("/movie/1001/photos")));
  // An empty photo wall leaves the poster in place.
  await expect(page.locator("#detailHero")).not.toHaveClass(/has-backdrop/);
});

test("landscape hero shows the TMDB backdrop behind the info and hides the poster", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => localStorage.setItem("decotv.detailHero", JSON.stringify("backdrop")));
  // Record the hero's class the first time it exists: the page must be laid
  // out for the backdrop from the first frame, never poster-then-backdrop.
  await page.evaluate(() => {
    window.__firstHeroClass = null;
    new MutationObserver((_, obs) => {
      const hero = document.querySelector("#detail #detailHero");
      if (hero && window.__firstHeroClass === null) {
        window.__firstHeroClass = hero.className;
        obs.disconnect();
      }
    }).observe(document.getElementById("detail"), { childList: true, subtree: true, attributes: true });
  });
  await page.evaluate((work) => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "", work }), TMDB_WORK);
  await page.waitForFunction(() => window.__firstHeroClass !== null);
  expect(await page.evaluate(() => window.__firstHeroClass)).toContain("has-backdrop");
  await expect(page.locator("#detailHero")).toHaveClass(/has-backdrop/, { timeout: 10000 });
  await expect(page.locator("#detailBackdrop img.detail-backdrop-img")).toHaveCount(1);
  await expect(page.locator("#detailPoster")).toBeHidden();
});
