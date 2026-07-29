// tests/posterImage.test.js — how a poster gets into the markup.
// Run: node --test tests/posterImage.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { posterAttrs } = await import("../js/ui/posterImage.js");
const { api } = await import("../js/core/network/decotvClient.js");

const DOUBAN = "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg";

function withLuna(present, fn) {
  const previous = globalThis.window;
  globalThis.window = present ? { webOS: { service: { request() {} } } } : undefined;
  try { return fn(); } finally { globalThis.window = previous; }
}

describe("posterAttrs", () => {
  test("on the TV the address is withheld from the webview", () => {
    const attrs = withLuna(true, () => posterAttrs(DOUBAN));
    // Handing the webview the real address would cost a round trip to discover
    // it is not allowed to load it: Douban answers 418 without a Referer that
    // a file:// document cannot send.
    assert.ok(attrs.includes('src="data:image/gif;base64,'), attrs);
    assert.ok(attrs.includes(`data-poster="${DOUBAN}"`), attrs);
  });

  test("browser preview still points at the DecoTV proxy", () => {
    api.setBaseUrl("http://tv.local:4000");
    const attrs = withLuna(false, () => posterAttrs(DOUBAN));
    assert.ok(attrs.includes("/api/image-proxy?url="), attrs);
    assert.ok(!attrs.includes("data-poster"), attrs);
  });

  test("no address yields a placeholder and nothing to fetch", () => {
    const attrs = withLuna(true, () => posterAttrs(""));
    assert.equal(attrs, 'src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"');
    assert.ok(!attrs.includes("data-poster"));
  });

  test("a quote in the address cannot break out of the attribute", () => {
    const attrs = withLuna(true, () => posterAttrs('https://x/a.jpg" onerror="alert(1)'));
    assert.ok(!attrs.includes('onerror="alert(1)"'), attrs);
    assert.ok(attrs.includes("&quot;"), attrs);
  });
});
