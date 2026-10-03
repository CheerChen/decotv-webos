import { test, expect } from "@playwright/test";
import { bootToHome } from "../helpers/harness.mjs";
import { press } from "../helpers/keys.mjs";

test("home card carries its douban work: detail shows the provider's metadata, the work is remembered", async ({ page }) => {
  await bootToHome(page);

  // Enter on the first home card autoplays; the work rides along and is
  // remembered under the playing source's title for continue watching.
  await press(page, "Enter");
  await page.waitForFunction(() => window.__router?.current === "player", null, { timeout: 15000 });
  const refs = await page.evaluate(() => JSON.parse(localStorage.getItem("decotv.workRefs") || "{}"));
  expect(Object.values(refs)).toContainEqual({ provider: "douban", kind: "movie", id: "1001" });

  // A later visit without the card (continue watching passes title + year
  // only) finds the work again and shows the provider's own metadata.
  await page.evaluate(() => window.__router.navigate("detail", { title: "测试剧集", year: "2024", poster: "" }));
  await expect(page.locator("#detailTags")).toContainText("豆瓣 8.5", { timeout: 10000 });
  await expect(page.locator("#detailTags")).toContainText("剧情 / 悬疑");
  await expect(page.locator("#detailDesc")).toHaveText("E2E 豆瓣简介");
  await expect(page.locator("#detailCast")).toContainText("导演：测试导演");
  await expect(page.locator("#detailCast")).toContainText("主演：演员甲 / 演员乙");
});

test("a work the provider does not know keeps the source-site metadata", async ({ page }) => {
  await bootToHome(page);
  await page.evaluate(() => window.__router.navigate("detail", {
    title: "测试剧集", year: "2024", poster: "", work: { provider: "douban", kind: "movie", id: "999" },
  }));
  await expect(page.locator("#detailStatus")).toContainText("已选", { timeout: 10000 });
  await expect(page.locator("#detailTags")).not.toContainText("豆瓣");
});
