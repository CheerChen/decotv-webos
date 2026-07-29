import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  LunaResponse,
  hasLunaTransport
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
});
