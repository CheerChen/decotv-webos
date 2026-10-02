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
var DoubanCache = require("./doubanCache").DoubanCache;
var tmdbUpstream = require("./tmdbUpstream.js");
var m3u8Filter = require("./m3u8AdFilter.js");
var segmentProbe = require("./segmentProbe.js");

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

// Douban rexxar fetch: direct catalog access from m.douban.com, bypassing
// the DecoTV server entirely. The webview cannot do this itself — the rexxar
// API answers 400 without a Referer header, which a file:// page cannot send
// (forbidden header). The service injects browser-looking headers and locks
// the request to the single Douban origin + /rexxar path prefix, mirroring
// how targetFor locks `request` to the DecoTV server's /api routes.
// GET only: every catalog call is a plain query. Responses are cached
// (doubanCache) — browsing revisits the same offsets constantly.
var DOUBAN_ORIGIN = "https://m.douban.com";
var DOUBAN_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var doubanCache = new DoubanCache();
var doubanAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function doubanTargetFor(payloadPath) {
  if (typeof payloadPath !== "string" ||
      payloadPath.charAt(0) !== "/" ||
      payloadPath.slice(0, 2) === "//") {
    throw new Error("A relative path is required");
  }
  var target = new URLCtor(payloadPath, DOUBAN_ORIGIN);
  if (originOf(target.href) !== DOUBAN_ORIGIN ||
      target.pathname.indexOf("/rexxar/") !== 0) {
    throw new Error("Only Douban /rexxar paths are allowed");
  }
  return target;
}

function fetchDouban(message) {
  var payload = message.payload || {};
  var responded = false;

  function respond(response) {
    if (responded) return;
    responded = true;
    message.respond(response);
  }

  function failDouban(error) {
    respond({ returnValue: false, error: String(error.message || error) });
  }

  var target;
  try {
    target = doubanTargetFor(payload.path);
  } catch (error) {
    failDouban(error);
    return;
  }

  var method = String(payload.method || "GET").toUpperCase();
  if (method !== "GET") {
    failDouban(new Error("HTTP method not allowed"));
    return;
  }

  var cacheKey = target.pathname + target.search;
  var cached = doubanCache.get(cacheKey);
  if (cached) {
    respond({
      returnValue: true,
      status: 200,
      contentType: "application/json",
      body: cached,
      cached: true
    });
    return;
  }

  // Verified against the live rexxar API: a plain UA is accepted as long as
  // the Referer is a Douban page; the bid cookie is Douban's anonymous
  // visitor id and a random one looks like a first-time visitor.
  var headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    "Referer": "https://m.douban.com/explore",
    "Cookie": "bid=" + Math.random().toString(36).slice(2, 13)
  };

  var req = https.request({
    protocol: "https:",
    hostname: target.hostname,
    port: 443,
    method: "GET",
    path: target.pathname + target.search,
    headers: headers,
    agent: doubanAgent
  }, function (res) {
    var chunks = [];
    var size = 0;
    var finished = false;

    res.on("data", function (chunk) {
      if (finished) return;
      size += chunk.length;
      if (size > DOUBAN_MAX_RESPONSE_BYTES) {
        finished = true;
        req.destroy();
        failDouban(new Error("Douban response exceeds 2 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", function () {
      if (finished) return;
      finished = true;
      var body = Buffer.concat(chunks).toString("utf8");
      var status = res.statusCode;
      if (status === 200) {
        doubanCache.set(cacheKey, body);
      }
      respond({
        returnValue: true,
        status: status,
        contentType: res.headers["content-type"] || "",
        body: body
      });
    });
  });

  var requestedTimeout = Number(payload.timeoutMs);
  var timeoutMs = requestedTimeout > 0
    ? Math.min(Math.max(requestedTimeout, 1000), 60000)
    : 15000;
  req.setTimeout(timeoutMs, function () {
    req.destroy(new Error("Douban upstream timeout"));
  });
  req.on("error", function (error) {
    failDouban(error);
  });
  req.end();
}

service.register("fetchDouban", fetchDouban);

// TMDB fetch: catalog JSON from api.themoviedb.org. The page builds the
// /3/ path (chart / discover / images); the service locks the origin, adds
// the bundled API key (tmdb.key, see tmdbUpstream.js) and caches list
// responses. GET only. A missing key fails every call, which the page turns
// into its Douban fallback.
var TMDB_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var tmdbCredential = tmdbUpstream.loadCredential(path.join(__dirname, "tmdb.key"));
// Lists change slowly (trending is weekly); six hours keeps a browsing
// session warm without serving yesterday's "now playing" all day.
var tmdbCache = new DoubanCache(6 * 60 * 60 * 1000, 300);
var tmdbAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function fetchTmdb(message) {
  var payload = message.payload || {};
  var responded = false;

  function respond(response) {
    if (responded) return;
    responded = true;
    message.respond(response);
  }

  function failTmdb(error) {
    respond({ returnValue: false, error: String(error.message || error) });
  }

  if (!tmdbCredential) {
    failTmdb(new Error("TMDB key is not bundled"));
    return;
  }

  var target;
  try {
    target = tmdbUpstream.tmdbTargetFor(payload.path);
  } catch (error) {
    failTmdb(error);
    return;
  }

  var method = String(payload.method || "GET").toUpperCase();
  if (method !== "GET") {
    failTmdb(new Error("HTTP method not allowed"));
    return;
  }

  var upstream = tmdbUpstream.upstreamRequest(target, tmdbCredential);
  var useCache = tmdbUpstream.cacheable(target);
  var cached = useCache ? tmdbCache.get(upstream.cacheKey) : null;
  if (cached) {
    respond({
      returnValue: true,
      status: 200,
      contentType: "application/json",
      body: cached,
      cached: true
    });
    return;
  }

  var req = https.request({
    protocol: "https:",
    hostname: target.hostname,
    port: 443,
    method: "GET",
    path: upstream.path,
    headers: upstream.headers,
    agent: tmdbAgent
  }, function (res) {
    var chunks = [];
    var size = 0;
    var finished = false;

    res.on("data", function (chunk) {
      if (finished) return;
      size += chunk.length;
      if (size > TMDB_MAX_RESPONSE_BYTES) {
        finished = true;
        req.destroy();
        failTmdb(new Error("TMDB response exceeds 2 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", function () {
      if (finished) return;
      finished = true;
      var body = Buffer.concat(chunks).toString("utf8");
      var status = res.statusCode;
      if (status === 200 && useCache) {
        tmdbCache.set(upstream.cacheKey, body);
      }
      respond({
        returnValue: true,
        status: status,
        contentType: res.headers["content-type"] || "",
        body: body
      });
    });
  });

  var requestedTimeout = Number(payload.timeoutMs);
  var timeoutMs = requestedTimeout > 0
    ? Math.min(Math.max(requestedTimeout, 1000), 60000)
    : 15000;
  req.setTimeout(timeoutMs, function () {
    req.destroy(new Error("TMDB upstream timeout"));
  });
  req.on("error", function (error) {
    failTmdb(error);
  });
  req.end();
}

service.register("fetchTmdb", fetchTmdb);

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
      images: images.diagnostics(),
      m3u8ProxyPort: m3u8ProxyPort
    });
  } catch (error) {
    fail(message, error);
  }
});

// ── m3u8 ad-filter proxy server ───────────────────────────────────────────
// A localhost HTTP server that rewrites HLS playlists to strip
// dynamically-stitched ad segments before the player's native HLS pipeline
// sees them. The webview sets video.src to
//   http://127.0.0.1:<port>/proxy?url=<upstream m3u8>
// and the pipeline fetches every playlist through this single-fetch path,
// so ad positions that drift between requests can no longer sneak in.
//
// Segments are left as direct CDN URLs (bandwidth); only playlists are
// proxied. The filter core is in m3u8AdFilter.js (pure functions).
//
// The server starts when the service is first launched (any Luna call wakes
// it) and lives as long as the service process. webOS dynamic services are
// killed after idle, so the app must keep the service alive by calling a
// Luna method periodically during playback — getM3u8ProxyPort doubles as
// the keepalive ping.

var M3U8_PROXY_PORT = Number(process.env.DECOTV_M3U8_PORT) || 3999;
var M3U8_UPSTREAM_TIMEOUT_MS = 12000;
var M3U8_PROXY_UA = "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager";
var m3u8ProxyPort = 0; // 0 = not started

// Extract the first variant URL from a master playlist, resolved against
// the master's own URL. Returns null if no variant is found.
function firstVariantFromMaster(text, baseUrl) {
  var lines = String(text).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
      var j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        var nxt = lines[j].trim();
        if (nxt && nxt.charAt(0) !== "#") return resolveUrl(baseUrl, nxt);
      }
    }
  }
  return null;
}

// Resolve a possibly-relative URL against a base URL. Works on old Node.
function resolveUrl(base, rel) {
  try { return new URLCtor(rel, base).href; }
  catch (_) { return rel; }
}

function fetchUpstreamM3u8(targetUrl, cb) {
  var target;
  try { target = new URLCtor(targetUrl); }
  catch (e) { cb(e); return; }
  var client = target.protocol === "https:" ? https : http;
  var agent = target.protocol === "https:" ? httpsAgent : httpAgent;
  var chunks = [];
  var req = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: "GET",
    path: target.pathname + target.search,
    headers: { "User-Agent": M3U8_PROXY_UA, "Accept": "*/*" },
    agent: agent
  }, function (res) {
    // Manual redirect follow — old Node's http.request doesn't auto-follow.
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      var next = new URLCtor(res.headers.location, targetUrl).href;
      res.resume();
      fetchUpstreamM3u8(next, cb);
      return;
    }
    res.on("data", function (c) { chunks.push(c); });
    res.on("end", function () {
      cb(null, {
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        finalUrl: targetUrl
      });
    });
  });
  req.setTimeout(M3U8_UPSTREAM_TIMEOUT_MS, function () {
    req.destroy(new Error("upstream timeout"));
  });
  req.on("error", function (e) { cb(e); });
  req.end();
}

// ── Segment probe plumbing ────────────────────────────────────────────────
//
// Byte-range GET for the coded-signature probe. A CDN that ignores Range
// would otherwise stream a whole 2-6s segment (1-3MB) per probed group, so
// the response is cut off as soon as enough bytes are in hand.
var M3U8_PROBE_TIMEOUT_MS = 5000;

function fetchUpstreamBytes(targetUrl, maxBytes, cb, depth) {
  var hops = depth || 0;
  if (hops > 3) { cb(new Error("too many redirects")); return; }
  var target;
  try { target = new URLCtor(targetUrl); }
  catch (e) { cb(e); return; }
  var client = target.protocol === "https:" ? https : http;
  var agent = target.protocol === "https:" ? httpsAgent : httpAgent;
  var chunks = [];
  var got = 0;
  var settled = false;
  var settle = function (err, buf) {
    if (settled) return;
    settled = true;
    cb(err, buf);
  };
  var req = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: "GET",
    path: target.pathname + target.search,
    headers: {
      "User-Agent": M3U8_PROXY_UA,
      "Accept": "*/*",
      "Range": "bytes=0-" + (maxBytes - 1)
    },
    agent: agent
  }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      fetchUpstreamBytes(new URLCtor(res.headers.location, targetUrl).href, maxBytes, cb, hops + 1);
      return;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      settle(new Error("HTTP " + res.statusCode));
      return;
    }
    res.on("data", function (chunk) {
      if (settled) return;
      chunks.push(chunk);
      got += chunk.length;
      if (got >= maxBytes) {
        settle(null, Buffer.concat(chunks).subarray(0, maxBytes));
        try { req.destroy(); } catch (_) {}
      }
    });
    res.on("end", function () {
      settle(null, Buffer.concat(chunks).subarray(0, maxBytes));
    });
    res.on("error", function (e) { settle(e); });
  });
  req.setTimeout(M3U8_PROBE_TIMEOUT_MS, function () {
    req.destroy(new Error("probe timeout"));
  });
  req.on("error", function (e) { settle(e); });
  req.end();
}

var segmentProber = segmentProbe.createSegmentProber({
  fetchBytes: fetchUpstreamBytes
});

// ── Source resolution read ────────────────────────────────────────────────
//
// The app ranks sources by what they can actually serve, not by the
// upstream's RESOLUTION label — one measured stream declared 1080x608 while
// carrying 1920x1080, and the server-side probe's quality field only ever
// echoes that label. The truth comes from the bitstream, which is what this
// endpoint reads: master → best variant → one segment head → H.264 SPS.
//
// The variant with the highest declared resolution is measured, not the
// first one: the app cannot steer the TV's ABR, so the useful question for
// ranking is what the source CAN serve. The OSD's videoWidth x videoHeight
// remains the ground truth for what actually rendered.

// Highest declared RESOLUTION, then highest BANDWIDTH, then playlist order.
function bestVariantFromMaster(text, baseUrl) {
  var lines = String(text).split(/\r?\n/);
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
    var j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) continue;
    var uri = lines[j].trim();
    if (!uri || uri.charAt(0) === "#") continue;
    var res = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    var bw = line.match(/BANDWIDTH=(\d+)/i);
    var area = res ? Number(res[1]) * Number(res[2]) : 0;
    var bandwidth = bw ? Number(bw[1]) : 0;
    if (!best || area > best.area || (area === best.area && bandwidth > best.bandwidth)) {
      best = { uri: uri, area: area, bandwidth: bandwidth };
    }
  }
  return best ? resolveUrl(baseUrl, best.uri) : null;
}

// The longest group is the content: ad blocks are a minority of the duration,
// and a head-inserted ad would otherwise be what the first segment measures.
function longestGroup(groups) {
  var best = null;
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g.firstUrl || !(g.duration > 0)) continue;
    if (!best || g.duration > best.duration) best = g;
  }
  return best || groups[0] || null;
}

function probeStreamResolution(playlistUrl, cb) {
  var started = Date.now();
  fetchUpstreamM3u8(playlistUrl, function (err, up) {
    if (err || !up || up.status !== 200) {
      cb(null, { ok: false, error: err ? String(err.message || err) : "upstream " + (up && up.status) });
      return;
    }
    var mediaText = up.body;
    var mediaUrl = up.finalUrl;
    if (m3u8Filter.isMasterPlaylist(mediaText)) {
      var variant = bestVariantFromMaster(mediaText, mediaUrl);
      if (!variant) {
        cb(null, { ok: false, error: "no variant" });
        return;
      }
      fetchUpstreamM3u8(variant, function (err2, up2) {
        if (err2 || !up2 || up2.status !== 200) {
          cb(null, { ok: false, error: err2 ? String(err2.message || err2) : "variant " + (up2 && up2.status) });
          return;
        }
        measureMediaPlaylist(up2.body, up2.finalUrl, started, cb);
      });
      return;
    }
    measureMediaPlaylist(mediaText, mediaUrl, started, cb);
  });
}

function measureMediaPlaylist(text, finalUrl, started, cb) {
  var analysis;
  try { analysis = m3u8Filter.analyzeGroups(text, finalUrl); }
  catch (e) { cb(null, { ok: false, error: "parse: " + (e.message || e) }); return; }
  var group = longestGroup(analysis.groups);
  if (!group) {
    cb(null, { ok: false, error: "no segments" });
    return;
  }
  segmentProber.measure(group, function (err, res) {
    if (err || !res || !res.dims) {
      cb(null, {
        ok: false,
        error: (err && (err.message || err)) || res && res.failure || "no sps",
        groups: analysis.groups.length,
        elapsedMs: Date.now() - started
      });
      return;
    }
    cb(null, {
      ok: true,
      w: res.dims.w,
      h: res.dims.h,
      level: res.dims.level,
      groups: analysis.groups.length,
      cached: Boolean(res.cached),
      encrypted: Boolean(group.key),
      elapsedMs: Date.now() - started
    });
  });
}

// Decide which groups to delete for a media playlist.
//
// The URL-signature rule is free, so the coded-signature probe only runs when
// that rule cannot see the playlist's ad blocks at all: no group deviates
// from the majority signature (the same-directory family), or there is no
// majority signature to compare against. Otherwise the answer would not
// change and the probe would only add latency to the player's playlist fetch.
//
// The verdict also reports whether it COVERED every group of the playlist
// (verdictComplete). The app uses that to skip its own background pre-scan:
// when the proxy classified every group, the client's scan could only repeat
// the same 512KB-per-group probes.
//
// Never throws and never blocks the response: on any failure the caller gets
// an empty, explicitly incomplete verdict and the playlist is filtered by
// signature alone.
function classifyAdGroups(text, finalUrl, cb) {
  var analysis;
  try { analysis = m3u8Filter.analyzeGroups(text, finalUrl); }
  catch (e) {
    console.log("[m3u8-proxy] group analysis failed: " + (e.message || e));
    cb(null, { adGroupIndices: [], verdictComplete: false });
    return;
  }
  if (!segmentProbe.needsProbe(analysis)) {
    // The signature rule decides every group on its own — complete, no probe.
    cb(analysis, { adGroupIndices: [], verdictComplete: true, probeRan: false });
    return;
  }

  segmentProber.classify(analysis, function (err, verdict) {
    if (err) {
      console.log("[m3u8-proxy] probe failed: " + (err.message || err));
      cb(analysis, { adGroupIndices: [], verdictComplete: false });
      return;
    }
    var complete = verdict.failed === 0
      && !verdict.unprobed
      && !verdict.budgetExceeded;
    if (verdict.adGroupIndices.length || verdict.failed || verdict.budgetExceeded) {
      console.log("[m3u8-proxy] probe " + JSON.stringify({
        groups: analysis.groups.length,
        probed: verdict.probed,
        failed: verdict.failed,
        unprobed: verdict.unprobed || 0,
        ads: verdict.adGroupIndices.length,
        encrypted: Boolean(verdict.encrypted),
        budgetExceeded: Boolean(verdict.budgetExceeded),
        baseline: verdict.baseline,
        elapsedMs: verdict.elapsedMs
      }));
    }
    cb(analysis, {
      adGroupIndices: verdict.adGroupIndices,
      verdictComplete: complete,
      probeRan: true
    });
  });
}

var m3u8Server = http.createServer(function (req, res) {
  // CORS — the webview is file://, every request here is cross-origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  var parsed;
  try { parsed = new URLCtor(req.url, "http://127.0.0.1:" + M3U8_PROXY_PORT); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
    return;
  }

  if (parsed.pathname === "/proxy") {
    var targetUrl = parsed.searchParams.get("url");
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("missing url");
      return;
    }
    var wantMeta = parsed.searchParams.get("meta") === "1";
    fetchUpstreamM3u8(targetUrl, function (err, up) {
      if (err) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("upstream fail: " + (err.message || err));
        return;
      }
      if (up.status !== 200) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("upstream status " + up.status);
        return;
      }
      // For master playlists, meta is not meaningful on the master itself
      // (ad ranges live on the media playlist). Resolve the first variant
      // and return its removed ranges so the caller gets a useful answer
      // from a single request.
      if (wantMeta) {
        var respondRanges = function (body, url) {
          classifyAdGroups(body, url, function (analysis, verdict) {
            var ranges = [];
            try {
              ranges = m3u8Filter.removedAdRanges(body, url, {
                adGroupIndices: verdict.adGroupIndices
              });
            } catch (_) { ranges = []; }
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store"
            });
            res.end(JSON.stringify({
              removedRanges: ranges,
              verdictComplete: Boolean(verdict.verdictComplete)
            }));
          });
        };
        if (m3u8Filter.isMasterPlaylist(up.body)) {
          var variantUrl = firstVariantFromMaster(up.body, up.finalUrl);
          if (!variantUrl) {
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store"
            });
            res.end(JSON.stringify({ removedRanges: [], verdictComplete: false }));
            return;
          }
          fetchUpstreamM3u8(variantUrl, function (e2, up2) {
            if (e2 || !up2 || up2.status !== 200) {
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store"
              });
              res.end(JSON.stringify({ removedRanges: [], verdictComplete: false }));
              return;
            }
            respondRanges(up2.body, up2.finalUrl);
          });
          return;
        }
        respondRanges(up.body, up.finalUrl);
        return;
      }
      var proxyBase = "http://127.0.0.1:" + m3u8ProxyPort + "/proxy";
      var rewriteUrl = function (u, opts) {
        if (opts && opts.kind === "variant") {
          return proxyBase + "?url=" + encodeURIComponent(u);
        }
        return u; // segments direct
      };
      classifyAdGroups(up.body, up.finalUrl, function (analysis, verdict) {
        try {
          var rewritten = m3u8Filter.filterPlaylist(up.body, up.finalUrl, {
            rewriteUrl: rewriteUrl,
            adGroupIndices: verdict.adGroupIndices
          });
          res.writeHead(200, {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store"
          });
          res.end(rewritten);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("rewrite fail: " + (e.message || e));
        }
      });
    });
    return;
  }

  // Source resolution read. Answers 200 with { ok: false } for a stream that
  // could not be measured, so the app can tell "measured nothing" from "no
  // such endpoint" (a 404 means the service predates this feature).
  if (parsed.pathname === "/probe") {
    var probeTarget = parsed.searchParams.get("url");
    if (!probeTarget) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("missing url");
      return;
    }
    probeStreamResolution(probeTarget, function (err, result) {
      var body = result || { ok: false, error: err ? String(err.message || err) : "failed" };
      if (body.ok) {
        console.log("[m3u8-proxy] resolution " + JSON.stringify({
          w: body.w,
          h: body.h,
          level: body.level,
          groups: body.groups,
          cached: Boolean(body.cached),
          elapsedMs: body.elapsedMs
        }));
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify(body));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// Bind with a retry ladder. Measured failure mode: after the service process
// is killed and relaunched, listen() on the previous port can fail while the
// old socket lingers — a fixed port would leave the proxy dead forever. Walk
// up from the base port with a short delay per attempt; the app never
// hardcodes the port (it asks getM3u8ProxyPort before every playback), so a
// changed port is picked up on the next play.
var M3U8_PORT_ATTEMPTS = 10;
var M3U8_PORT_RETRY_DELAY_MS = 250;
var m3u8ProxyState = "starting"; // starting | ready | failed
var m3u8PortWaiters = []; // getM3u8ProxyPort callers awaiting bind settle

function respondM3u8Port(message) {
  message.respond({
    returnValue: true,
    port: m3u8ProxyPort,
    ready: m3u8ProxyPort > 0
  });
}

function settleM3u8Bind(state) {
  m3u8ProxyState = state;
  var waiters = m3u8PortWaiters;
  m3u8PortWaiters = [];
  for (var i = 0; i < waiters.length; i++) {
    try { respondM3u8Port(waiters[i]); } catch (_) {}
  }
}

function bindM3u8Server(attempt) {
  var port = M3U8_PROXY_PORT + attempt;
  // Manage both listeners explicitly: listen(port, host, cb) would leave its
  // "listening" once-listener behind on a failed attempt, and every stale one
  // would fire (with its stale port) when a later attempt succeeds.
  var onError = function (e) {
    m3u8Server.removeListener("listening", onListening);
    console.log("[m3u8-proxy] bind :" + port + " failed: " + (e.message || e));
    if (attempt + 1 < M3U8_PORT_ATTEMPTS) {
      setTimeout(function () { bindM3u8Server(attempt + 1); }, M3U8_PORT_RETRY_DELAY_MS);
    } else {
      console.log("[m3u8-proxy] all bind attempts failed, proxy disabled");
      settleM3u8Bind("failed");
    }
  };
  var onListening = function () {
    m3u8Server.removeListener("error", onError);
    // Post-bind runtime errors must not crash the whole service process.
    m3u8Server.on("error", function (e) {
      console.log("[m3u8-proxy] server error: " + (e.message || e));
    });
    m3u8ProxyPort = port;
    console.log("[m3u8-proxy] listening on http://127.0.0.1:" + m3u8ProxyPort);
    settleM3u8Bind("ready");
  };
  m3u8Server.once("error", onError);
  m3u8Server.once("listening", onListening);
  m3u8Server.listen(port, "127.0.0.1");
}

bindM3u8Server(0);

// App queries the proxy port before every playback (and polls it as the
// keepalive ping during proxied playback). While the bind ladder is still
// running — the common case right after a cold service wake — defer the
// response until it settles, so the app never sees a spurious ready:false.
service.register("getM3u8ProxyPort", function (message) {
  if (m3u8ProxyState === "starting") {
    m3u8PortWaiters.push(message);
    return;
  }
  respondM3u8Port(message);
});

// NOTE: a subscribe-mode "keepalive" method used to live here. Measured
// on-device: an open Luna subscription keeps the Luna layer alive but does
// NOT prevent the HTTP server from dying at the ~10s dynamic-service idle
// timeout. The app pins the service by polling getM3u8ProxyPort every 5s
// during proxied playback instead (lunaTransport.subscribeKeepalive).
