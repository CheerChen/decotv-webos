import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { TmdbClient } from "../js/core/network/tmdbClient.js";

describe("TmdbClient sidecar URL derivation", () => {
  test("derives same-host port 4001 from the DecoTV server URL", () => {
    const client = new TmdbClient();
    assert.equal(
      client.deriveSidecarUrl("http://192.168.0.110:4000"),
      "http://192.168.0.110:4001"
    );
  });

  test("keeps https and non-standard ports, replaces only the port", () => {
    const client = new TmdbClient();
    assert.equal(
      client.deriveSidecarUrl("https://deco.example.com:8443"),
      "https://deco.example.com:4001"
    );
  });

  test("returns empty for a missing or invalid server URL", () => {
    const client = new TmdbClient();
    assert.equal(client.deriveSidecarUrl(""), "");
    assert.equal(client.deriveSidecarUrl("not a url"), "");
  });

  test("explicit stored URL wins over derived", () => {
    const client = new TmdbClient();
    client.setSidecarUrl("http://192.168.0.99:4001");
    assert.equal(client.resolveSidecarUrl("http://192.168.0.110:4000"), "http://192.168.0.99:4001");
    assert.equal(client._ensureUrl(), "http://192.168.0.99:4001");
  });

  test("derives from server base URL when nothing stored", () => {
    const client = new TmdbClient();
    client.setServerBaseUrl("http://192.168.0.110:4000");
    assert.equal(client.resolveSidecarUrl(), "http://192.168.0.110:4001");
    assert.equal(client._ensureUrl(), "http://192.168.0.110:4001");
    assert.equal(client.isConfigured(), true);
  });

  test("isConfigured is false without server or stored URL", () => {
    const client = new TmdbClient();
    assert.equal(client.isConfigured(), false);
  });
});
