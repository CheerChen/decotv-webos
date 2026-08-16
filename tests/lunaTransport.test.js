import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  LunaResponse,
  hasLunaTransport,
  lunaFetchImage,
  lunaSidecarFetchImage
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

  test("lunaSidecarFetchImage routes via fetchSidecar with base64 encoding", async () => {
    const previous = globalThis.window;
    let call;
    globalThis.window = {
      webOS: {
        service: {
          request(uri, options) {
            call = { uri, method: options.method, parameters: options.parameters };
            options.onSuccess({
              returnValue: true,
              status: 200,
              contentType: "image/jpeg",
              encoding: "base64",
              body: Buffer.from("poster-bytes").toString("base64")
            });
            return { cancel() {} };
          }
        }
      }
    };
    try {
      const result = await lunaSidecarFetchImage(
        "http://192.168.0.110:4001",
        "http://192.168.0.110:4001/api/image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fa.jpg"
      );
      assert.equal(call.method, "fetchSidecar");
      // Full sidecar URL is reduced to the relative path the service expects.
      assert.equal(
        call.parameters.path,
        "/api/image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fa.jpg"
      );
      assert.equal(call.parameters.responseEncoding, "base64");
      assert.equal(result.contentType, "image/jpeg");
      assert.equal(result.source, "sidecar");
      // The Luna body is base64; the caller decodes it later via atob.
      assert.equal(result.base64, Buffer.from("poster-bytes").toString("base64"));
    } finally {
      globalThis.window = previous;
    }
  });

  test("lunaSidecarFetchImage parses bare paths through URL", async () => {
    const previous = globalThis.window;
    let call;
    globalThis.window = {
      webOS: {
        service: {
          request(uri, options) {
            call = { parameters: options.parameters };
            options.onSuccess({ returnValue: true, status: 200, body: "" });
            return { cancel() {} };
          }
        }
      }
    };
    try {
      await lunaSidecarFetchImage(
        "http://192.168.0.110:4001",
        "/api/image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fb.jpg"
      );
      assert.equal(
        call.parameters.path,
        "/api/image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw500%2Fb.jpg"
      );
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
