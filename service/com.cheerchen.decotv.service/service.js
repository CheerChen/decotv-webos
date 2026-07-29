"use strict";

// DecoTV authentication proxy for webOS.
// Compatible with the older Node runtimes found on webOS TVs: CommonJS,
// callbacks, and only built-in modules.

var Service = require("webos-service");
var http = require("http");
var https = require("https");
var fs = require("fs");
var crypto = require("crypto");
var URLCtor = require("url").URL;
var SessionStore = require("./sessionStore").SessionStore;
var originOf = require("./sessionStore").originOf;

var SERVICE_ID = "com.cheerchen.decotv.service";
var SESSION_FILE = "/media/internal/decotv_sessions.json";
var MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
var service = new Service(SERVICE_ID);
var sessions = new SessionStore(SESSION_FILE);
// Source probing runs many requests at once and they are latency-bound on the
// upstream CDN rather than on this process. A 6-socket pool was measured
// serialising a 12-way probe into two waves (14.7s); a wider pool let the same
// batch finish in one (9.0s). Keep this >= the app's probe concurrency.
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

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

// ── Posters ────────────────────────────────────────────────────────────────
//
// The webview cannot fetch a poster by itself, for two independent reasons.
// DecoTV puts a middleware in front of /api/* that answers 401 without the
// auth cookie, and a cross-site cookie is exactly what a file:// page cannot
// carry — so /api/image-proxy is closed to it. Going to the image host
// directly does not work either: Douban answers 418 unless the request carries
// a browser Accept and a Referer of https://movie.douban.com/, and a file://
// document sends neither.
//
// Fetching here settles both. This process can set any header, and a public
// image host wants no cookie, so DecoTV is not involved in posters at all.
// The bytes come back base64 for the app to turn into a blob: writing them to
// disk instead is not an option, because the service is jailed and cannot see
// the app directory, while WAM only grants file:// access inside it.

var IMAGE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var MAX_IMAGE_REDIRECTS = 3;

var inFlight = {};

function refererFor(hostname) {
  // Only Douban demands one, and only its own origin will do.
  return /(^|\.)doubanio\.com$/.test(hostname) || /(^|\.)douban\.com$/.test(hostname)
    ? "https://movie.douban.com/"
    : "";
}

function fetchImage(rawUrl, redirectsLeft, callback) {
  var target;
  try {
    target = new URLCtor(rawUrl);
  } catch (error) {
    callback(new Error("Invalid image URL"));
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    callback(new Error("Only HTTP(S) images are supported"));
    return;
  }

  var headers = {
    "User-Agent": IMAGE_USER_AGENT,
    "Accept": IMAGE_ACCEPT,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  };
  var referer = refererFor(target.hostname);
  if (referer) headers.Referer = referer;

  var client = target.protocol === "https:" ? https : http;
  var req = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: "GET",
    path: target.pathname + target.search,
    headers: headers,
    agent: target.protocol === "https:" ? httpsAgent : httpAgent
  }, function (res) {
    var status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) { callback(new Error("Too many redirects")); return; }
      fetchImage(new URLCtor(res.headers.location, target).href, redirectsLeft - 1, callback);
      return;
    }
    if (status !== 200) {
      res.resume();
      callback(new Error("Image host answered " + status));
      return;
    }
    var chunks = [];
    var size = 0;
    var failed = false;
    res.on("data", function (chunk) {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        failed = true;
        req.destroy();
        callback(new Error("Image exceeds 4 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", function () {
      if (failed) return;
      callback(null, Buffer.concat(chunks), res.headers["content-type"] || "");
    });
  });
  req.setTimeout(15000, function () { req.destroy(new Error("Image request timed out")); });
  req.on("error", function (error) { callback(error); });
  req.end();
}

service.register("fetchImage", function (message) {
  var url = String((message.payload || {}).url || "");
  if (!url) {
    message.respond({ returnValue: false, error: "Missing image URL" });
    return;
  }

  // A poster wall asks several rows for the same cover at once.
  if (inFlight[url]) {
    inFlight[url].push(message);
    return;
  }
  inFlight[url] = [message];

  fetchImage(url, MAX_IMAGE_REDIRECTS, function (error, body, contentType) {
    var waiting = inFlight[url] || [];
    delete inFlight[url];
    if (error) {
      waiting.forEach(function (m) {
        m.respond({ returnValue: false, error: String(error.message || error) });
      });
      return;
    }
    var response = {
      returnValue: true,
      contentType: contentType || "image/jpeg",
      base64: body.toString("base64")
    };
    waiting.forEach(function (m) { m.respond(response); });
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
      cookieKeys: keys
    });
  } catch (error) {
    fail(message, error);
  }
});
