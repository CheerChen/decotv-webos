"use strict";

var http = require("http");
var https = require("https");
var URLCtor = require("url").URL;
var originOf = require("./sessionStore").originOf;

var POLICY_VERSION = "image-v2";
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var MAX_IMAGE_REDIRECTS = 3;
var IMAGE_TIMEOUT_MS = 15000;
// Long enough to prevent a full poster wall from repeating a known-broken
// proxy request, short enough to probe the authenticated path again soon.
var BREAKER_TTL_MS = 30 * 1000;
var IMAGE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

function imageError(message, code, properties) {
  var error = new Error(message);
  error.code = code;
  Object.keys(properties || {}).forEach(function (key) {
    error[key] = properties[key];
  });
  return error;
}

function hostnameAllowed(hostname) {
  var host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return /(^|\.)doubanio\.com$/.test(host) ||
    /(^|\.)douban\.com$/.test(host);
}

function parseImageUrl(rawUrl) {
  var target;
  try {
    target = new URLCtor(rawUrl);
  } catch (_) {
    throw imageError("Invalid image URL", "INVALID_URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw imageError("Only HTTP(S) images are supported", "INVALID_URL");
  }
  if (target.username || target.password) {
    throw imageError("Credentials are not allowed in image URLs", "INVALID_URL");
  }
  return target;
}

function directTarget(rawUrl) {
  var target = parseImageUrl(rawUrl);
  if (target.protocol !== "https:" || !hostnameAllowed(target.hostname) ||
      (target.port && target.port !== "443")) {
    throw imageError("Direct image host is not trusted", "UNTRUSTED_IMAGE_HOST");
  }
  return target;
}

function validImage(contentType, body) {
  var mediaType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (mediaType.indexOf("image/") !== 0 || !Buffer.isBuffer(body)) return false;
  if (body.length >= 3 &&
      body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true;
  if (body.length >= 8 &&
      body.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  if (body.length >= 6) {
    var gif = body.toString("ascii", 0, 6);
    if (gif === "GIF87a" || gif === "GIF89a") return true;
  }
  if (body.length >= 12 &&
      body.toString("ascii", 0, 4) === "RIFF" &&
      body.toString("ascii", 8, 12) === "WEBP") return true;
  if (body.length >= 12 && body.toString("ascii", 4, 8) === "ftyp") {
    var brands = body.toString("ascii", 8, Math.min(body.length, 32));
    if (brands.indexOf("avif") >= 0 || brands.indexOf("avis") >= 0) return true;
  }
  if (body.length >= 2 && body.toString("ascii", 0, 2) === "BM") return true;
  if (body.length >= 4) {
    var tiff = body.toString("hex", 0, 4);
    if (tiff === "49492a00" || tiff === "4d4d002a") return true;
  }
  return false;
}

function upstreamFailureBody(body) {
  var text = body.toString("utf8", 0, Math.min(body.length, 4096));
  return /upstream image request failed|upstream request failed|failed to fetch upstream/i.test(text);
}

function emptyStats() {
  return {
    requests: 0,
    coalesced: 0,
    cacheHit: 0,
    cacheMiss: 0,
    cacheError: 0,
    proxyHit: 0,
    proxyError: 0,
    proxyBypassed: 0,
    directHit: 0,
    directError: 0,
    bytes: { cache: 0, proxy: 0, direct: 0 },
    timeMs: { cache: 0, proxy: 0, direct: 0 }
  };
}

function ImagePipeline(options) {
  options = options || {};
  this.sessions = options.sessions;
  this.cache = options.cache;
  this.http = options.http || http;
  this.https = options.https || https;
  this.httpAgent = options.httpAgent;
  this.httpsAgent = options.httpsAgent;
  this.now = options.now || Date.now;
  this.timeoutMs = options.timeoutMs || IMAGE_TIMEOUT_MS;
  this.breakerTtlMs = options.breakerTtlMs || BREAKER_TTL_MS;
  this.breakers = {};
  this.inFlight = {};
  this.stats = emptyStats();
}

ImagePipeline.prototype.scopeFor = function (origin) {
  return POLICY_VERSION + "\0" + origin;
};

ImagePipeline.prototype.breakerKey = function (origin, target) {
  return origin + "\0" + target.hostname.toLowerCase();
};

ImagePipeline.prototype.breakerOpen = function (key) {
  var expiresAt = this.breakers[key] || 0;
  if (expiresAt <= this.now()) {
    delete this.breakers[key];
    return false;
  }
  return true;
};

ImagePipeline.prototype.requestBytes = function (target, headers, callback) {
  var self = this;
  var client = target.protocol === "https:" ? this.https : this.http;
  var finished = false;
  var req;

  function finish(error, response) {
    if (finished) return;
    finished = true;
    if (wallTimer) clearTimeout(wallTimer);
    callback(error, response);
  }

  var wallTimer = null;
  try {
    req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: target.pathname + target.search,
      headers: headers,
      agent: target.protocol === "https:" ? this.httpsAgent : this.httpAgent
    }, function (res) {
      var chunks = [];
      var size = 0;
      var contentLength = Number(res.headers["content-length"]);
      if (contentLength > MAX_IMAGE_BYTES) {
        req.destroy();
        finish(imageError("Image exceeds 4 MiB", "IMAGE_TOO_LARGE"));
        return;
      }
      res.on("data", function (chunk) {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          req.destroy();
          finish(imageError("Image exceeds 4 MiB", "IMAGE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", function () {
        if (finished) return;
        finish(null, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
      res.on("error", function (error) { finish(error); });
    });
  } catch (error) {
    finish(error);
    return;
  }
  wallTimer = setTimeout(function () {
    var error = imageError("Image request timed out", "IMAGE_TIMEOUT");
    req.destroy();
    finish(error);
  }, this.timeoutMs);
  if (wallTimer.unref) wallTimer.unref();
  req.on("error", function (error) { finish(error); });
  req.end();
};

ImagePipeline.prototype.fetchProxy = function (origin, logicalUrl, callback) {
  var self = this;
  var target = new URLCtor(
    "/api/image-proxy?url=" + encodeURIComponent(logicalUrl),
    origin
  );
  var headers = {
    "Accept": IMAGE_ACCEPT,
    "User-Agent": "DecoTV-webOS-Service/0.1"
  };
  var cookie = this.sessions.cookieHeader(origin);
  if (cookie) headers.Cookie = cookie;
  var startedAt = this.now();
  this.requestBytes(target, headers, function (error, response) {
    self.stats.timeMs.proxy += Math.max(0, self.now() - startedAt);
    if (error) {
      callback(imageError(
        error.message || error,
        error.code || "PROXY_NETWORK_ERROR",
        { fallbackEligible: false }
      ));
      return;
    }
    self.sessions.capture(origin, response.headers["set-cookie"]);
    self.stats.bytes.proxy += response.body.length;
    if (response.status === 401 || response.status === 407) {
      callback(imageError(
        "DecoTV image proxy authentication failed (" + response.status + ")",
        "PROXY_AUTH_ERROR",
        { status: response.status, fallbackEligible: false }
      ));
      return;
    }
    if (response.status !== 200) {
      callback(imageError(
        "DecoTV image proxy answered " + response.status,
        "PROXY_HTTP_ERROR",
        {
          status: response.status,
          fallbackEligible: upstreamFailureBody(response.body)
        }
      ));
      return;
    }
    var contentType = response.headers["content-type"] || "";
    if (!validImage(contentType, response.body)) {
      callback(imageError(
        "DecoTV image proxy returned non-image content",
        "PROXY_INVALID_CONTENT",
        { fallbackEligible: false }
      ));
      return;
    }
    callback(null, {
      body: response.body,
      contentType: contentType,
      source: "proxy"
    });
  });
};

ImagePipeline.prototype.fetchDirect = function (rawUrl, redirectsLeft, callback, startedAt) {
  var self = this;
  var target;
  try {
    target = directTarget(rawUrl);
  } catch (error) {
    callback(error);
    return;
  }
  startedAt = startedAt || this.now();
  var headers = {
    "User-Agent": IMAGE_USER_AGENT,
    "Accept": IMAGE_ACCEPT,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://movie.douban.com/"
  };
  this.requestBytes(target, headers, function (error, response) {
    if (error) {
      self.stats.timeMs.direct += Math.max(0, self.now() - startedAt);
      callback(error);
      return;
    }
    self.stats.bytes.direct += response.body.length;
    if (response.status >= 300 && response.status < 400 &&
        response.headers.location) {
      if (redirectsLeft <= 0) {
        self.stats.timeMs.direct += Math.max(0, self.now() - startedAt);
        callback(imageError("Too many image redirects", "DIRECT_REDIRECT_ERROR"));
        return;
      }
      var next;
      try {
        next = new URLCtor(response.headers.location, target).href;
        directTarget(next);
      } catch (_) {
        self.stats.timeMs.direct += Math.max(0, self.now() - startedAt);
        callback(imageError(
          "Image redirect left the trusted HTTPS hosts",
          "DIRECT_REDIRECT_ERROR"
        ));
        return;
      }
      self.fetchDirect(next, redirectsLeft - 1, callback, startedAt);
      return;
    }
    self.stats.timeMs.direct += Math.max(0, self.now() - startedAt);
    if (response.status !== 200) {
      callback(imageError(
        "Image host answered " + response.status,
        "DIRECT_HTTP_ERROR",
        { status: response.status }
      ));
      return;
    }
    var contentType = response.headers["content-type"] || "";
    if (!validImage(contentType, response.body)) {
      callback(imageError(
        "Image host returned non-image content",
        "DIRECT_INVALID_CONTENT"
      ));
      return;
    }
    callback(null, {
      body: response.body,
      contentType: contentType,
      source: "direct"
    });
  });
};

ImagePipeline.prototype.fetchNetwork = function (origin, logicalUrl, target, callback) {
  var self = this;
  var breakerKey = this.breakerKey(origin, target);

  function direct(openBreakerOnSuccess) {
    self.fetchDirect(logicalUrl, MAX_IMAGE_REDIRECTS, function (error, result) {
      if (error) {
        self.stats.directError++;
        callback(error);
        return;
      }
      self.stats.directHit++;
      if (openBreakerOnSuccess) {
        self.breakers[breakerKey] = self.now() + self.breakerTtlMs;
      }
      callback(null, result);
    });
  }

  if (hostnameAllowed(target.hostname) && this.breakerOpen(breakerKey)) {
    this.stats.proxyBypassed++;
    direct(false);
    return;
  }

  this.fetchProxy(origin, logicalUrl, function (error, result) {
    if (!error) {
      self.stats.proxyHit++;
      callback(null, result);
      return;
    }
    self.stats.proxyError++;
    if (!error.fallbackEligible || target.protocol !== "https:" ||
        !hostnameAllowed(target.hostname)) {
      callback(error);
      return;
    }
    direct(true);
  });
};

ImagePipeline.prototype.fetch = function (baseUrl, logicalUrl, callback) {
  var self = this;
  var origin;
  var target;
  try {
    origin = originOf(baseUrl);
    target = parseImageUrl(logicalUrl);
  } catch (error) {
    callback(error);
    return;
  }
  var requestKey = origin + "\0" + target.href;
  this.stats.requests++;
  if (this.inFlight[requestKey]) {
    this.stats.coalesced++;
    this.inFlight[requestKey].push(callback);
    return;
  }
  this.inFlight[requestKey] = [callback];

  function finish(error, result) {
    var waiting = self.inFlight[requestKey] || [];
    delete self.inFlight[requestKey];
    waiting.forEach(function (done) { done(error, result); });
  }

  var cacheStartedAt = this.now();
  this.cache.get(this.scopeFor(origin), target.href, function (cacheError, cached) {
    self.stats.timeMs.cache += Math.max(0, self.now() - cacheStartedAt);
    if (cacheError) self.stats.cacheError++;
    if (cached) {
      self.stats.cacheHit++;
      self.stats.bytes.cache += cached.body.length;
      finish(null, {
        body: cached.body,
        contentType: cached.contentType,
        source: "cache"
      });
      return;
    }
    self.stats.cacheMiss++;
    self.fetchNetwork(origin, target.href, target, function (networkError, result) {
      if (networkError) {
        finish(networkError);
        return;
      }
      self.cache.put(
        self.scopeFor(origin),
        target.href,
        result.body,
        result.contentType,
        function (putError) {
          if (putError) self.stats.cacheError++;
          finish(null, result);
        }
      );
    });
  });
};

ImagePipeline.prototype.diagnostics = function () {
  return {
    policyVersion: POLICY_VERSION,
    requests: this.stats.requests,
    coalesced: this.stats.coalesced,
    cacheHit: this.stats.cacheHit,
    cacheMiss: this.stats.cacheMiss,
    cacheError: this.stats.cacheError,
    proxyHit: this.stats.proxyHit,
    proxyError: this.stats.proxyError,
    proxyBypassed: this.stats.proxyBypassed,
    directHit: this.stats.directHit,
    directError: this.stats.directError,
    bytes: {
      cache: this.stats.bytes.cache,
      proxy: this.stats.bytes.proxy,
      direct: this.stats.bytes.direct
    },
    timeMs: {
      cache: this.stats.timeMs.cache,
      proxy: this.stats.timeMs.proxy,
      direct: this.stats.timeMs.direct
    },
    cache: this.cache.diagnostics()
  };
};

module.exports = {
  ImagePipeline: ImagePipeline,
  hostnameAllowed: hostnameAllowed,
  parseImageUrl: parseImageUrl,
  directTarget: directTarget,
  validImage: validImage,
  upstreamFailureBody: upstreamFailureBody,
  POLICY_VERSION: POLICY_VERSION
};
