const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  ImagePipeline,
  directTarget,
  hostnameAllowed,
  validImage
} = require("../service/com.cheerchen.decotv.service/imagePipeline.js");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

function fakeClient(items) {
  const requests = [];
  return {
    requests,
    request(options, onResponse) {
      requests.push(options);
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = (error) => {
        if (error) process.nextTick(() => req.emit("error", error));
      };
      req.end = () => {
        const item = items.shift();
        if (!item) throw new Error("Unexpected HTTP request");
        if (item.error) {
          process.nextTick(() => req.emit("error", item.error));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = item.status;
        res.headers = item.headers || {};
        res.resume = () => {};
        onResponse(res);
        process.nextTick(() => {
          if (item.body !== undefined) res.emit("data", Buffer.from(item.body));
          res.emit("end");
        });
      };
      return req;
    }
  };
}

class MemoryCache {
  constructor() {
    this.values = new Map();
    this.stats = { hit: 0, miss: 0 };
  }

  id(scope, url) {
    return `${scope}\0${url}`;
  }

  get(scope, url, callback) {
    const value = this.values.get(this.id(scope, url)) || null;
    if (value) this.stats.hit++;
    else this.stats.miss++;
    process.nextTick(() => callback(null, value));
  }

  put(scope, url, body, contentType, callback) {
    this.values.set(this.id(scope, url), { body, contentType });
    process.nextTick(() => callback(null));
  }

  diagnostics() {
    return { ...this.stats, entries: this.values.size, bytes: 0 };
  }
}

function sessions() {
  return {
    captured: [],
    cookieHeader: () => "auth=secret",
    capture(origin, headers) {
      this.captured.push({ origin, headers });
    }
  };
}

function fetchImage(pipeline, baseUrl, url) {
  return new Promise((resolve) => {
    pipeline.fetch(baseUrl, url, (error, result) => resolve({ error, result }));
  });
}

function response(status, contentType, body, headers = {}) {
  return {
    status,
    body,
    headers: { "content-type": contentType, ...headers }
  };
}

describe("service image pipeline", () => {
  test("uses the authenticated DecoTV proxy first and then the disk cache", async () => {
    const transport = fakeClient([
      response(200, "image/jpeg; charset=binary", JPEG)
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });
    const imageUrl = "https://img9.doubanio.com/a.jpg";

    const first = await fetchImage(pipeline, "https://deco.test/path", imageUrl);
    const second = await fetchImage(pipeline, "https://deco.test", imageUrl);

    assert.equal(first.error, null);
    assert.equal(first.result.source, "proxy");
    assert.equal(second.result.source, "cache");
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].hostname, "deco.test");
    assert.match(transport.requests[0].path, /^\/api\/image-proxy\?url=/);
    assert.equal(transport.requests[0].headers.Cookie, "auth=secret");
    assert.equal(pipeline.diagnostics().proxyHit, 1);
    assert.equal(pipeline.diagnostics().cacheHit, 1);
  });

  test("falls back only after a confirmed upstream failure and opens a host breaker", async () => {
    const transport = fakeClient([
      response(403, "text/plain", "Upstream image request failed: Forbidden"),
      response(200, "image/jpeg", JPEG),
      response(200, "image/jpeg", JPEG)
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });
    const firstUrl = "https://img9.doubanio.com/a.jpg";
    const secondUrl = "https://img9.doubanio.com/b.jpg";

    const first = await fetchImage(pipeline, "https://deco.test", firstUrl);
    const second = await fetchImage(pipeline, "https://deco.test", secondUrl);

    assert.equal(first.result.source, "direct");
    assert.equal(second.result.source, "direct");
    assert.equal(transport.requests.length, 3);
    assert.equal(transport.requests[1].hostname, "img9.doubanio.com");
    assert.equal(transport.requests[1].headers.Cookie, undefined);
    assert.equal(transport.requests[1].headers.Referer, "https://movie.douban.com/");
    assert.equal(pipeline.diagnostics().proxyError, 1);
    assert.equal(pipeline.diagnostics().proxyBypassed, 1);
    assert.equal(pipeline.diagnostics().directHit, 2);
  });

  test("does not open the proxy breaker when the direct recovery also fails", async () => {
    const transport = fakeClient([
      response(403, "text/plain", "Upstream image request failed: Forbidden"),
      response(503, "text/plain", "unavailable"),
      response(403, "text/plain", "Upstream image request failed: Forbidden"),
      response(200, "image/jpeg", JPEG)
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });

    const first = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://img9.doubanio.com/a.jpg"
    );
    const second = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://img9.doubanio.com/b.jpg"
    );

    assert.equal(first.error.code, "DIRECT_HTTP_ERROR");
    assert.equal(second.result.source, "direct");
    assert.equal(transport.requests.length, 4);
    assert.equal(pipeline.diagnostics().proxyBypassed, 0);
  });

  test("does not mask proxy authentication failures", async () => {
    const transport = fakeClient([
      response(401, "application/json", '{"error":"Unauthorized"}')
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });

    const result = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://img9.doubanio.com/a.jpg"
    );

    assert.equal(result.result, undefined);
    assert.equal(result.error.code, "PROXY_AUTH_ERROR");
    assert.equal(transport.requests.length, 1);
    assert.equal(pipeline.diagnostics().directHit, 0);
  });

  test("does not treat an arbitrary proxy error as an upstream failure", async () => {
    const transport = fakeClient([
      response(403, "application/json", '{"error":"Forbidden"}')
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });

    const result = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://img9.doubanio.com/a.jpg"
    );

    assert.equal(result.error.code, "PROXY_HTTP_ERROR");
    assert.equal(transport.requests.length, 1);
    assert.equal(pipeline.diagnostics().directHit, 0);
  });

  test("never directly fetches an untrusted host", async () => {
    const transport = fakeClient([
      response(502, "text/plain", "Upstream image request failed")
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });

    const result = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://private.example/a.jpg"
    );

    assert.equal(result.error.code, "PROXY_HTTP_ERROR");
    assert.equal(transport.requests.length, 1);
  });

  test("rechecks every direct redirect before following it", async () => {
    const transport = fakeClient([
      response(403, "text/plain", "Upstream image request failed: Forbidden"),
      response(302, "", "", { location: "https://metadata.google.internal/a" })
    ]);
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: new MemoryCache(),
      http: transport,
      https: transport
    });

    const result = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://img9.doubanio.com/a.jpg"
    );

    assert.equal(result.error.code, "DIRECT_REDIRECT_ERROR");
    assert.equal(transport.requests.length, 2);
  });

  test("serves the network result when the persistent cache is unavailable", async () => {
    const transport = fakeClient([
      response(200, "image/jpeg", JPEG)
    ]);
    const brokenCache = {
      get(_scope, _url, callback) {
        process.nextTick(() => callback(Object.assign(new Error("read-only"), { code: "EROFS" }), null));
      },
      put(_scope, _url, _body, _type, callback) {
        process.nextTick(() => callback(Object.assign(new Error("disk full"), { code: "ENOSPC" })));
      },
      diagnostics() {
        return { entries: 0, bytes: 0, error: 2 };
      }
    };
    const pipeline = new ImagePipeline({
      sessions: sessions(),
      cache: brokenCache,
      http: transport,
      https: transport
    });

    const result = await fetchImage(
      pipeline,
      "https://deco.test",
      "https://img9.doubanio.com/a.jpg"
    );

    assert.equal(result.error, null);
    assert.equal(result.result.source, "proxy");
    assert.equal(pipeline.diagnostics().cacheError, 2);
  });

  test("enforces exact trusted-domain and HTTPS boundaries", () => {
    assert.equal(hostnameAllowed("img9.doubanio.com"), true);
    assert.equal(hostnameAllowed("DOUBAN.COM."), true);
    assert.equal(hostnameAllowed("doubanio.com.evil.test"), false);
    assert.throws(
      () => directTarget("http://img9.doubanio.com/a.jpg"),
      /not trusted/
    );
    assert.throws(
      () => directTarget("https://douban.com.evil.test/a.jpg"),
      /not trusted/
    );
    assert.throws(
      () => directTarget("https://img9.doubanio.com:444/a.jpg"),
      /not trusted/
    );
    assert.equal(validImage("image/jpeg", Buffer.from("not really an image")), false);
    assert.equal(validImage("image/jpeg", JPEG), true);
  });
});
