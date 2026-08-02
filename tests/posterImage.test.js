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

const { hydratePosters, posterAttrs } = await import("../js/ui/posterImage.js");
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

  test("hydration sends the selected server and reports a loaded state", async () => {
    const previousWindow = globalThis.window;
    const previousCreate = globalThis.URL.createObjectURL;
    let parameters;
    const listeners = {};
    const img = {
      dataset: { poster: DOUBAN },
      style: {},
      addEventListener(name, callback) { listeners[name] = callback; },
      set src(value) {
        this._src = value;
        listeners.load?.();
      },
      get src() { return this._src; }
    };
    api.setBaseUrl("https://deco.test");
    globalThis.URL.createObjectURL = () => "blob:poster";
    globalThis.window = {
      webOS: {
        service: {
          request(_uri, options) {
            parameters = options.parameters;
            options.onSuccess({
              returnValue: true,
              base64: "cG9zdGVy",
              contentType: "image/jpeg",
              source: "proxy"
            });
            return { cancel() {} };
          }
        }
      }
    };
    try {
      hydratePosters({ querySelectorAll: () => [img] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(parameters, {
        baseUrl: "https://deco.test",
        url: DOUBAN
      });
      assert.equal(img.src, "blob:poster");
      assert.equal(img.dataset.posterState, "loaded");
    } finally {
      globalThis.window = previousWindow;
      globalThis.URL.createObjectURL = previousCreate;
    }
  });

  test("the placeholder cannot make a pending poster look loaded", async () => {
    const previousWindow = globalThis.window;
    const previousCreate = globalThis.URL.createObjectURL;
    const listeners = {};
    let finishRequest;
    const poster = "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2.jpg";
    const img = {
      dataset: { poster },
      style: {},
      addEventListener(name, callback) { listeners[name] = callback; },
      set src(value) {
        this._src = value;
        listeners.load?.();
      },
      get src() { return this._src; }
    };
    api.setBaseUrl("https://deco-pending.test");
    globalThis.URL.createObjectURL = () => "blob:pending-poster";
    globalThis.window = {
      webOS: {
        service: {
          request(_uri, options) {
            finishRequest = options.onSuccess;
            return { cancel() {} };
          }
        }
      }
    };
    try {
      hydratePosters({ querySelectorAll: () => [img] });
      assert.equal(img.dataset.posterState, "pending");
      assert.equal(listeners.load, undefined);

      finishRequest({
        returnValue: true,
        base64: "cG9zdGVy",
        contentType: "image/jpeg",
        source: "proxy"
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(img.src, "blob:pending-poster");
      assert.equal(img.dataset.posterState, "loaded");
    } finally {
      globalThis.window = previousWindow;
      globalThis.URL.createObjectURL = previousCreate;
    }
  });
});
