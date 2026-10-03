import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press } from "../helpers/keys.mjs";

test("热门动漫 is a Bangumi catalog under either provider; a card opens its Bangumi work", async ({ page }) => {
  await bootToHome(page);
  // Registered after boot so they take precedence over the harness aborts.
  await page.route("https://next.bgm.tv/p1/trending/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ data: Array.from({ length: 25 }, (_, i) => ({ subject: {
      id: 700 + i, type: 2, nsfw: false, name: `Original ${i}`, nameCN: i === 0 ? "测试剧集" : `E2E 番${i}`,
      images: { common: "https://img.example/a.jpg" }, rating: { score: 7.5, total: 900 }, metaTags: ["日本"],
      info: "12话 / 2024年1月1日",
    } })) }),
  }));
  await page.route("https://api.bgm.tv/v0/subjects/700", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 700, name_cn: "测试剧集", date: "2024-01-01", rating: { score: 7.5, total: 900 }, meta_tags: [], infobox: [] }),
  }));
  await page.route("https://api.bgm.tv/v0/episodes?**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }),
  }));

  for (const provider of ["tmdb", "douban"]) {
    await page.evaluate((p) => localStorage.setItem("decotv.catalogProvider", JSON.stringify(p)), provider);
    await page.evaluate(() => window.__router.navigate("search", { type: "hot-anime" }));
    // Douban's chips, not TMDB's sort chips, whatever the provider.
    await expect(page.locator("#searchFilters .chip")).toHaveText(["全部", "国产", "日本", "欧美", "每日放送"]);
    await expect(page.locator("#searchBody .poster-card")).toHaveCount(20, { timeout: 10000 });
    await expect(page.locator("#searchBody .poster-card").first()).toContainText("测试剧集");
    await page.evaluate(() => window.__router.navigate("home", {}));
  }

  // A card opens detail with its Bangumi work: the provider's rating shows.
  await page.evaluate(() => window.__router.navigate("search", { type: "hot-anime", focusFirstItem: true }));
  await expect(page.locator("#searchBody .poster-card")).toHaveCount(20, { timeout: 10000 });
  await page.locator("#searchBody .poster-card").first().evaluate((el) => el.scrollIntoView());
  await expect(page.locator("#search .poster-card.focused")).toHaveCount(1, { timeout: 5000 });
  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "detail" || window.__router?.current === "player");
  const refs = await page.evaluate(() => JSON.parse(localStorage.getItem("decotv.workRefs") || "{}"));
  expect(Object.values(refs)).toContainEqual({ provider: "bangumi", kind: "", id: "700" });
});
