const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SessionStore,
  originOf,
  parseSetCookie
} = require("../service/com.cheerchen.decotv.service/sessionStore.js");

const temporaryDirectories = [];

function makeStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "decotv-session-"));
  temporaryDirectories.push(directory);
  return {
    file: path.join(directory, "sessions.json"),
    store: new SessionStore(path.join(directory, "sessions.json"))
  };
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("service session store", () => {
  test("normalizes the server to an HTTP(S) origin", () => {
    assert.equal(originOf("http://192.168.0.110:4000/path"), "http://192.168.0.110:4000");
    assert.throws(() => originOf("file:///tmp/server"), /HTTP/);
    assert.throws(() => originOf("http://user:pass@example.com"), /Credentials/);
  });

  test("captures and removes Set-Cookie values", () => {
    const auth = parseSetCookie("auth=abc%20123; Path=/; SameSite=Lax");
    assert.deepEqual(auth, { name: "auth", value: "abc%20123", remove: false });
    assert.equal(parseSetCookie("auth=; Max-Age=0; Path=/").remove, true);
  });

  test("persists isolated cookie jars per server origin", () => {
    const { file, store } = makeStore();
    store.capture("http://one.test:4000", ["auth=one; Path=/; SameSite=Lax"]);
    store.capture("https://two.test", ["auth=two; Path=/"]);

    const restored = new SessionStore(file);
    assert.equal(restored.cookieHeader("http://one.test:4000"), "auth=one");
    assert.equal(restored.cookieHeader("https://two.test"), "auth=two");

    restored.capture("http://one.test:4000", ["auth=; Max-Age=0; Path=/"]);
    assert.equal(restored.cookieHeader("http://one.test:4000"), "");
    assert.equal(restored.cookieHeader("https://two.test"), "auth=two");
  });
});
