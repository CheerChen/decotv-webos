"use strict";

// In-memory TTL cache for Douban rexxar JSON responses, shared by the
// fetchDouban service method. Reduces repeat upstream hits (grid revisits,
// page flips that re-request the same offsets) and keeps the TV's home IP
// well below Douban's rate-limit radar. Memory only: a service restart
// starts cold, which is fine — the catalog is browse data, not credentials.
//
// Deliberately ES5 + plain objects: this file runs on the older Node runtime
// bundled with webOS, same constraint as the rest of the service.

function DoubanCache(ttlMs, maxEntries) {
  this.ttlMs = ttlMs || 15 * 60 * 1000;
  this.maxEntries = maxEntries || 300;
  this.entries = {}; // key -> { body, expires }
  this.order = [];   // insertion order, oldest first (LRU eviction)
}

DoubanCache.prototype.get = function (key) {
  var entry = this.entries[key];
  if (!entry) return null;
  if (Date.now() >= entry.expires) {
    this._remove(key);
    return null;
  }
  // LRU touch: move to the newest end of the order list.
  this._remove(key);
  this.entries[key] = entry;
  this.order.push(key);
  return entry.body;
};

DoubanCache.prototype.set = function (key, body) {
  if (this.entries[key]) this._remove(key);
  this.entries[key] = { body: body, expires: Date.now() + this.ttlMs };
  this.order.push(key);
  while (this.order.length > this.maxEntries) {
    this._remove(this.order[0]);
  }
};

DoubanCache.prototype._remove = function (key) {
  delete this.entries[key];
  var i = this.order.indexOf(key);
  if (i >= 0) this.order.splice(i, 1);
};

DoubanCache.prototype.size = function () {
  return this.order.length;
};

DoubanCache.prototype.clear = function () {
  this.entries = {};
  this.order = [];
};

exports.DoubanCache = DoubanCache;
