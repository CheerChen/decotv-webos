"use strict";

// DecoTV authentication proxy for webOS.
// Compatible with the older Node runtimes found on webOS TVs: CommonJS,
// callbacks, and only built-in modules.

var Service = require("webos-service");
var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");
var URLCtor = require("url").URL;
var SessionStore = require("./sessionStore").SessionStore;
var originOf = require("./sessionStore").originOf;
var ImageCache = require("./imageCache").ImageCache;
var ImagePipeline = require("./imagePipeline").ImagePipeline;

var SERVICE_ID = "com.cheerchen.decotv.service";
// The cookie jar lives INSIDE the service's install directory on purpose: its
// lifetime must match the app's. An earlier location on /media/internal
// survived uninstall and reinstall, which meant removing the app never
// revoked the authorization — and a reinstall silently resumed the session,
// making the login flow untestable.
var SESSION_FILE = path.join(__dirname, "sessions.json");
// Pre-0.5.1 location; delete it so no credential cookie outlives the app.
var LEGACY_SESSION_FILE = "/media/internal/decotv_sessions.json";
try { fs.unlinkSync(LEGACY_SESSION_FILE); } catch (_) {}
// The image cache is content, not credentials — surviving a reinstall is fine.
var IMAGE_CACHE_DIR = "/media/internal/decotv_image_cache";
var MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
var service = new Service(SERVICE_ID);
var sessions = new SessionStore(SESSION_FILE);
// Source probing runs many requests at once and they are latency-bound on the
// upstream CDN rather than on this process. A 6-socket pool was measured
// serialising a 12-way probe into two waves (14.7s); a wider pool let the same
// batch finish in one (9.0s). Keep this >= the app's probe concurrency.
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
var imageCache = new ImageCache(IMAGE_CACHE_DIR);
var images = new ImagePipeline({
  sessions: sessions,
  cache: imageCache,
  httpAgent: httpAgent,
  httpsAgent: httpsAgent
});

function fail(message, error) {
  message.respond({ returnValue: false, error: String(error.message || error) });
}

function targetFor(baseUrl, relativePath) {
  var origin = originOf(baseUrl);
  if (typeof relativePath !== "string" ||
      relativePath.charAt(0) !== "/" ||
      relativePath.slice(0, 2) === "//") {
    throw new Error("A relative API path is required");
  }
  var target = new URLCtor(relativePath, origin);
  if (originOf(target.href) !== origin || target.pathname.indexOf("/api/") !== 0) {
    throw new Error("Only the selected DecoTV server's /api routes are allowed");
  }
  return target;
}

function request(message) {
  var payload = message.payload || {};
  var target;
  var responded = false;

  function respond(response) {
    if (responded) return;
    responded = true;
    message.respond(response);
  }

  function failRequest(error) {
    respond({ returnValue: false, error: String(error.message || error) });
  }

  try {
    target = targetFor(payload.baseUrl, payload.path);
  } catch (error) {
    failRequest(error);
    return;
  }

  var method = String(payload.method || "GET").toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].indexOf(method) < 0) {
    failRequest(new Error("HTTP method not allowed"));
    return;
  }

  var body = typeof payload.body === "string" ? payload.body : "";
  var headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "DecoTV-webOS-Service/0.1"
  };
  var cookie = sessions.cookieHeader(payload.baseUrl);
  if (cookie) headers.Cookie = cookie;
  if (payload.contentType) headers["Content-Type"] = String(payload.contentType);
  if (body) headers["Content-Length"] = Buffer.byteLength(body);

  var client = target.protocol === "https:" ? https : http;
  var req = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: method,
    path: target.pathname + target.search,
    headers: headers,
    agent: target.protocol === "https:" ? httpsAgent : httpAgent
  }, function (res) {
    sessions.capture(payload.baseUrl, res.headers["set-cookie"]);
    var chunks = [];
    var size = 0;
    var finished = false;

    res.on("data", function (chunk) {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        finished = true;
        req.destroy();
        failRequest(new Error("DecoTV response exceeds 8 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", function () {
      if (finished) return;
      finished = true;
      // utf8 mangles anything that is not text. Images have to come back as
      // base64 because the app cannot fetch them itself: the middleware gates
      // /api/image-proxy behind the auth cookie, and a webview <img> cannot
      // carry it.
      var encoding = payload.responseEncoding === "base64" ? "base64" : "utf8";
      respond({
        returnValue: true,
        status: res.statusCode,
        contentType: res.headers["content-type"] || "",
        encoding: encoding,
        body: Buffer.concat(chunks).toString(encoding)
      });
    });
  });

  var requestedTimeout = Number(payload.timeoutMs);
  var timeoutMs = requestedTimeout > 0
    ? Math.min(Math.max(requestedTimeout, 1000), 60000)
    : 60000;
  req.setTimeout(timeoutMs, function () {
    req.destroy(new Error("Upstream timeout"));
  });
  req.on("error", function (error) {
    failRequest(error);
  });
  if (body) req.write(body);
  req.end();
}

service.register("request", request);

// Posters use one stable Luna API. The service first asks the selected DecoTV
// server's authenticated image proxy, then (only for a confirmed upstream
// proxy failure) falls back to a tightly allowlisted image host. Both paths
// populate the same persistent cache.
service.register("fetchImage", function (message) {
  var payload = message.payload || {};
  var baseUrl = String(payload.baseUrl || "");
  var url = String(payload.url || "");
  if (!baseUrl || !url) {
    message.respond({
      returnValue: false,
      error: !baseUrl ? "Missing DecoTV server URL" : "Missing image URL"
    });
    return;
  }

  images.fetch(baseUrl, url, function (error, result) {
    if (error) {
      message.respond({
        returnValue: false,
        error: String(error.message || error),
        errorCode: error.code || "IMAGE_FETCH_FAILED",
        status: error.status || 0
      });
      return;
    }
    message.respond({
      returnValue: true,
      contentType: result.contentType || "image/jpeg",
      base64: result.body.toString("base64"),
      source: result.source
    });
  });
});

service.register("clearSession", function (message) {
  try {
    sessions.clear((message.payload || {}).baseUrl);
    message.respond({ returnValue: true });
  } catch (error) {
    fail(message, error);
  }
});

service.register("diagnostics", function (message) {
  try {
    var keys = sessions.cookieKeys((message.payload || {}).baseUrl);
    message.respond({
      returnValue: true,
      serviceId: SERVICE_ID,
      nodeVersion: process.version,
      hasSession: keys.indexOf("auth") >= 0,
      cookieKeys: keys,
      images: images.diagnostics()
    });
  } catch (error) {
    fail(message, error);
  }
});
