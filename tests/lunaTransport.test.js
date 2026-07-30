import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  LunaResponse,
  hasLunaTransport,
  lunaFetchImage
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
