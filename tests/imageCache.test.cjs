const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ImageCache
} = require("../service/com.cheerchen.decotv.service/imageCache.js");

const temporaryDirectories = [];

function makeDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "decotv-images-"));
  temporaryDirectories.push(directory);
  return directory;
}

function put(cache, scope, url, body, contentType = "image/jpeg") {
  return new Promise((resolve, reject) => {
    cache.put(scope, url, body, contentType, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function get(cache, scope, url) {
  return new Promise((resolve) => {
    cache.get(scope, url, (error, value) => resolve({ error, value }));
  });
}

function flush(cache) {
  return new Promise((resolve, reject) => {
    cache.flush((error) => error ? reject(error) : resolve());
  });
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("persistent image cache", () => {
  test("survives a new service process and isolates server scopes", async () => {
    const directory = makeDirectory();
    const first = new ImageCache(directory);
    await put(first, "v2\0https://one.test", "https://img.test/a.jpg", Buffer.from("one"));
    await put(first, "v2\0https://two.test", "https://img.test/a.jpg", Buffer.from("two"));
    await flush(first);

    const restored = new ImageCache(directory);
    const one = await get(restored, "v2\0https://one.test", "https://img.test/a.jpg");
    const two = await get(restored, "v2\0https://two.test", "https://img.test/a.jpg");

    assert.equal(one.error, null);
    assert.equal(one.value.body.toString(), "one");
    assert.equal(two.value.body.toString(), "two");
    assert.equal(restored.diagnostics().hit, 2);
  });

  test("expires entries and safely turns missing bodies into misses", async () => {
    const directory = makeDirectory();
    let now = 1000;
    const cache = new ImageCache(directory, { ttlMs: 100, now: () => now });
    const scope = "v2\0https://one.test";
    const url = "https://img.test/a.jpg";
    await put(cache, scope, url, Buffer.from("image"));

    now = 1200;
    const expired = await get(cache, scope, url);
    assert.equal(expired.value, null);

    now = 1300;
    await put(cache, scope, url, Buffer.from("again"));
    fs.unlinkSync(cache.bodyFile(cache.keyFor(scope, url)));
    const missing = await get(cache, scope, url);
    assert.equal(missing.value, null);
    assert.ok(missing.error);
    assert.ok(cache.diagnostics().error >= 1);
  });

  test("evicts approximately least-recently-used entries at the byte limit", async () => {
    const directory = makeDirectory();
    let now = 1;
    const cache = new ImageCache(directory, { maxBytes: 6, now: () => now++ });
    const scope = "v2\0https://one.test";
    await put(cache, scope, "https://img.test/a", Buffer.from("aaaa"));
    await put(cache, scope, "https://img.test/b", Buffer.from("bbbb"));

    const a = await get(cache, scope, "https://img.test/a");
    const b = await get(cache, scope, "https://img.test/b");
    assert.equal(a.value, null);
    assert.equal(b.value.body.toString(), "bbbb");
    assert.equal(cache.diagnostics().evicted, 1);
    assert.ok(cache.diagnostics().bytes <= 6);
  });

  test("recovers from a corrupt index without throwing", async () => {
    const directory = makeDirectory();
    fs.writeFileSync(path.join(directory, "index.json"), "{broken");
    fs.writeFileSync(path.join(directory, "a".repeat(64) + ".img"), "orphan");
    const cache = new ImageCache(directory);

    const result = await get(cache, "scope", "https://img.test/a");
    assert.equal(result.error, null);
    assert.equal(result.value, null);
    assert.ok(cache.diagnostics().error >= 1);
    assert.equal(fs.existsSync(path.join(directory, "a".repeat(64) + ".img")), false);
  });

  test("rejects malformed index keys before they can escape the cache directory", async () => {
    const directory = makeDirectory();
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({
      version: 1,
      entries: {
        "../../victim": {
          size: 1,
          contentType: "image/jpeg",
          createdAt: Date.now(),
          lastAccess: Date.now()
        }
      }
    }));
    const cache = new ImageCache(directory);

    const result = await get(cache, "scope", "https://img.test/a");
    assert.equal(result.error, null);
    assert.equal(result.value, null);
    assert.equal(cache.diagnostics().entries, 0);
    assert.throws(() => cache.bodyFile("../../victim"), /Invalid image cache key/);
  });
});
