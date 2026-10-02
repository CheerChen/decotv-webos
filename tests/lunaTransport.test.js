import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  LunaResponse,
  hasLunaTransport,
  lunaFetchImage,
  lunaTmdbFetch
} from "../js/core/network/lunaTransport.js";

describe("Luna transport response", () => {
  test("exposes the Response subset used by DecoTVClient", async () => {
    const response = new LunaResponse({
      status: 200,
      contentType: "application/json",
      body: "{\"ok\":true}"
    });

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.deepEqual(await response.json(), { ok: true });
  });

  test("is unavailable outside the webOS runtime", () => {
    assert.equal(hasLunaTransport(), false);
  });

  test("lunaTmdbFetch sends only the relative /3/ path to fetchTmdb", async () => {
    const previous = globalThis.window;
    let call;
    globalThis.window = {
      webOS: {
        service: {
          request(uri, options) {
            call = { method: options.method, parameters: options.parameters };
            options.onSuccess({
              returnValue: true,
              status: 200,
              contentType: "application/json",
              body: "{\"results\":[]}"
            });
            return { cancel() {} };
          }
        }
      }
    };
    try {
      const response = await lunaTmdbFetch("/3/trending/movie/week?language=zh-CN&page=1");
      assert.equal(call.method, "fetchTmdb");
      assert.equal(call.parameters.path, "/3/trending/movie/week?language=zh-CN&page=1");
      assert.equal(call.parameters.method, "GET");
      assert.deepEqual(await response.json(), { results: [] });
    } finally {
      globalThis.window = previous;
    }
  });

  test("lunaTmdbFetch surfaces a service-side failure", async () => {
    const previous = globalThis.window;
    globalThis.window = {
      webOS: {
        service: {
          request(uri, options) {
            options.onSuccess({ returnValue: false, error: "TMDB key is not bundled" });
            return { cancel() {} };
          }
        }
      }
    };
    try {
      await assert.rejects(lunaTmdbFetch("/3/x"), /TMDB key is not bundled/);
    } finally {
      globalThis.window = previous;
    }
  });

  test("passes both the selected server and logical image URL to Luna", async () => {
    const previous = globalThis.window;
    let call;
    globalThis.window = {
      webOS: {
        service: {
          request(uri, options) {
            call = { uri, method: options.method, parameters: options.parameters };
            options.onSuccess({
              returnValue: true,
              base64: "cG9zdGVy",
              contentType: "image/webp",
              source: "cache"
            });
            return { cancel() {} };
          }
        }
      }
    };
    try {
      const result = await lunaFetchImage(
        "https://deco.test",
        "https://img9.doubanio.com/a.jpg"
      );
      assert.equal(call.method, "fetchImage");
      assert.deepEqual(call.parameters, {
        baseUrl: "https://deco.test",
        url: "https://img9.doubanio.com/a.jpg"
      });
      assert.equal(result.contentType, "image/webp");
      assert.equal(result.source, "cache");
    } finally {
      globalThis.window = previous;
    }
  });
});
