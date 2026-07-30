"use strict";

// A small, best-effort disk cache for poster bytes. Cache failures must never
// make the image pipeline fail: callers receive a miss/error indication and
// can continue with the network.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
var DEFAULT_TTL_MS = 15720000 * 1000;
var INDEX_VERSION = 1;
var FLUSH_DELAY_MS = 2000;
var CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;

function noop() {}

function cloneStats(stats, entries, bytes) {
  return {
    entries: entries,
    bytes: bytes,
    hit: stats.hit,
    miss: stats.miss,
    error: stats.error,
    write: stats.write,
    evicted: stats.evicted
  };
}

function ImageCache(directory, options) {
  options = options || {};
  this.directory = directory;
  this.indexFile = path.join(directory, "index.json");
  this.maxBytes = Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : DEFAULT_MAX_BYTES;
  this.ttlMs = Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : DEFAULT_TTL_MS;
  this.now = options.now || Date.now;
  this.fs = options.fs || fs;
  this.entries = {};
  this.totalBytes = 0;
  this.ready = false;
  this.loading = false;
  this.waiters = [];
  this.flushTimer = null;
  this.flushing = false;
  this.dirty = false;
  this.stats = { hit: 0, miss: 0, error: 0, write: 0, evicted: 0 };
}

ImageCache.prototype.keyFor = function (scope, logicalUrl) {
  return crypto.createHash("sha256")
    .update(String(scope))
    .update("\0")
    .update(String(logicalUrl))
    .digest("hex");
};

ImageCache.prototype.bodyFile = function (key) {
  if (!CACHE_KEY_PATTERN.test(String(key || ""))) {
    throw new Error("Invalid image cache key");
  }
  return path.join(this.directory, key + ".img");
};

ImageCache.prototype.ensureReady = function (callback) {
  var self = this;
  if (this.ready) {
    callback();
    return;
  }
  this.waiters.push(callback);
  if (this.loading) return;
  this.loading = true;

  this.fs.mkdir(this.directory, { recursive: true, mode: 448 }, function (mkdirError) {
    if (mkdirError) {
      self.stats.error++;
      self.finishReady();
      return;
    }
    self.fs.readFile(self.indexFile, "utf8", function (readError, text) {
      if (!readError) {
        try {
          var parsed = JSON.parse(text);
          if (!parsed || parsed.version !== INDEX_VERSION ||
              !parsed.entries || typeof parsed.entries !== "object" ||
              Array.isArray(parsed.entries)) {
            throw new Error("Unsupported cache index");
          }
          self.entries = parsed.entries;
          self.recount();
        } catch (_) {
          self.entries = {};
          self.totalBytes = 0;
          self.stats.error++;
        }
      } else if (readError.code !== "ENOENT") {
        self.stats.error++;
      }
      self.cleanupDirectory(function () {
        self.finishReady();
      });
    });
  });
};

ImageCache.prototype.finishReady = function () {
  this.loading = false;
  this.ready = true;
  var waiting = this.waiters;
  this.waiters = [];
  waiting.forEach(function (callback) { callback(); });
};

ImageCache.prototype.recount = function () {
  var self = this;
  this.totalBytes = 0;
  Object.keys(this.entries).forEach(function (key) {
    var entry = self.entries[key];
    if (!CACHE_KEY_PATTERN.test(key) ||
        !entry || typeof entry.size !== "number" || !isFinite(entry.size) ||
        entry.size < 0 ||
        typeof entry.createdAt !== "number" || !isFinite(entry.createdAt) ||
        typeof entry.lastAccess !== "number" || !isFinite(entry.lastAccess) ||
        typeof entry.contentType !== "string") {
      delete self.entries[key];
      return;
    }
    self.totalBytes += entry.size;
  });
};

ImageCache.prototype.cleanupDirectory = function (callback) {
  var self = this;
  this.fs.readdir(this.directory, function (error, names) {
    if (error) {
      if (error.code !== "ENOENT") self.stats.error++;
      callback();
      return;
    }
    var pending = 0;
    names.forEach(function (name) {
      var orphan = /\.tmp(?:-|$)/.test(name) ||
        (/^[a-f0-9]{64}\.img$/.test(name) &&
          !self.entries[name.slice(0, 64)]);
      if (!orphan) return;
      pending++;
      self.fs.unlink(path.join(self.directory, name), function () {
        pending--;
        if (!pending) callback();
      });
    });
    if (!pending) callback();
  });
};

ImageCache.prototype.get = function (scope, logicalUrl, callback) {
  var self = this;
  this.ensureReady(function () {
    var key = self.keyFor(scope, logicalUrl);
    var entry = self.entries[key];
    if (!entry) {
      self.stats.miss++;
      callback(null, null);
      return;
    }
    if (self.now() - entry.createdAt > self.ttlMs) {
      self.remove(key);
      self.stats.miss++;
      callback(null, null);
      return;
    }
    self.fs.readFile(self.bodyFile(key), function (error, body) {
      if (error || body.length !== entry.size) {
        self.remove(key);
        self.stats.error++;
        self.stats.miss++;
        callback(error || new Error("Cached image size mismatch"), null);
        return;
      }
      entry.lastAccess = self.now();
      self.stats.hit++;
      self.scheduleFlush();
      callback(null, {
        body: body,
        contentType: entry.contentType
      });
    });
  });
};

ImageCache.prototype.put = function (scope, logicalUrl, body, contentType, callback) {
  var self = this;
  callback = callback || noop;
  if (!Buffer.isBuffer(body) || !body.length || body.length > this.maxBytes) {
    callback(new Error("Image cannot be cached"));
    return;
  }
  this.ensureReady(function () {
    var key = self.keyFor(scope, logicalUrl);
    var destination = self.bodyFile(key);
    var temporary = destination + ".tmp-" + process.pid + "-" +
      Math.random().toString(16).slice(2);
    self.fs.writeFile(temporary, body, { mode: 384 }, function (writeError) {
      if (writeError) {
        self.stats.error++;
        self.fs.unlink(temporary, noop);
        callback(writeError);
        return;
      }
      self.fs.rename(temporary, destination, function (renameError) {
        if (renameError) {
          self.stats.error++;
          self.fs.unlink(temporary, noop);
          callback(renameError);
          return;
        }
        var previous = self.entries[key];
        if (previous) self.totalBytes -= previous.size;
        self.entries[key] = {
          size: body.length,
          contentType: contentType,
          createdAt: self.now(),
          lastAccess: self.now()
        };
        self.totalBytes += body.length;
        self.stats.write++;
        self.evict(function () {
          self.scheduleFlush();
          callback(null);
        });
      });
    });
  });
};

ImageCache.prototype.remove = function (key) {
  var entry = this.entries[key];
  if (!entry) return;
  delete this.entries[key];
  this.totalBytes = Math.max(0, this.totalBytes - entry.size);
  this.fs.unlink(this.bodyFile(key), noop);
  this.scheduleFlush();
};

ImageCache.prototype.evict = function (callback) {
  var self = this;
  if (this.totalBytes <= this.maxBytes) {
    callback();
    return;
  }
  var oldest = Object.keys(this.entries).sort(function (a, b) {
    return self.entries[a].lastAccess - self.entries[b].lastAccess;
  });
  while (this.totalBytes > this.maxBytes && oldest.length) {
    var key = oldest.shift();
    var entry = this.entries[key];
    delete this.entries[key];
    this.totalBytes = Math.max(0, this.totalBytes - entry.size);
    this.stats.evicted++;
    this.fs.unlink(this.bodyFile(key), noop);
  }
  callback();
};

ImageCache.prototype.scheduleFlush = function () {
  var self = this;
  this.dirty = true;
  if (this.flushTimer || this.flushing) return;
  this.flushTimer = setTimeout(function () {
    self.flushTimer = null;
    self.flush();
  }, FLUSH_DELAY_MS);
  if (this.flushTimer.unref) this.flushTimer.unref();
};

ImageCache.prototype.flush = function (callback) {
  var self = this;
  callback = callback || noop;
  if (this.flushing || !this.dirty) {
    callback();
    return;
  }
  this.dirty = false;
  this.flushing = true;
  var temporary = this.indexFile + ".tmp";
  var payload = JSON.stringify({
    version: INDEX_VERSION,
    entries: this.entries
  });
  this.fs.writeFile(temporary, payload, { mode: 384 }, function (writeError) {
    if (writeError) {
      self.stats.error++;
      self.dirty = true;
      self.flushing = false;
      self.fs.unlink(temporary, noop);
      callback(writeError);
      return;
    }
    self.fs.rename(temporary, self.indexFile, function (renameError) {
      if (renameError) {
        self.stats.error++;
        self.dirty = true;
        self.fs.unlink(temporary, noop);
      }
      self.flushing = false;
      // A new mutation during a successful flush needs another snapshot.
      // A persistent rename failure stays dirty but waits for the next cache
      // operation instead of retrying against a full/read-only disk forever.
      if (!renameError && self.dirty) self.scheduleFlush();
      callback(renameError || null);
    });
  });
};

ImageCache.prototype.diagnostics = function () {
  return cloneStats(
    this.stats,
    Object.keys(this.entries).length,
    this.totalBytes
  );
};

module.exports = {
  ImageCache: ImageCache,
  DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
  DEFAULT_TTL_MS: DEFAULT_TTL_MS
};
