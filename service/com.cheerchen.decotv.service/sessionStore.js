"use strict";

var fs = require("fs");

function originOf(rawUrl) {
  var URLCtor = require("url").URL;
  var parsed = new URLCtor(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) DecoTV servers are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials are not allowed in the server URL");
  }
  return parsed.protocol + "//" + parsed.host;
}

function parseSetCookie(line) {
  if (!line || typeof line !== "string") return null;
  var parts = line.split(";");
  var pair = parts.shift();
  var separator = pair.indexOf("=");
  if (separator <= 0) return null;

  var cookie = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    remove: false
  };

  parts.forEach(function (part) {
    var i = part.indexOf("=");
    var name = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    var value = i < 0 ? "" : part.slice(i + 1).trim();
    if (name === "max-age" && Number(value) <= 0) cookie.remove = true;
    if (name === "expires") {
      var expires = Date.parse(value);
      if (!isNaN(expires) && expires <= Date.now()) cookie.remove = true;
    }
  });
  return cookie;
}

function SessionStore(file) {
  this.file = file;
  this.data = { version: 1, origins: {} };
  this.load();
}

SessionStore.prototype.load = function () {
  try {
    var loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (loaded && loaded.version === 1 && loaded.origins) this.data = loaded;
  } catch (_) {}
};

SessionStore.prototype.save = function () {
  try {
    var temporary = this.file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: 384 });
    fs.renameSync(temporary, this.file);
  } catch (_) {}
};

SessionStore.prototype.jarFor = function (baseUrl) {
  var origin = originOf(baseUrl);
  if (!this.data.origins[origin]) {
    this.data.origins[origin] = { cookies: {}, updatedAt: 0 };
  }
  return this.data.origins[origin];
};

SessionStore.prototype.cookieHeader = function (baseUrl) {
  var cookies = this.jarFor(baseUrl).cookies;
  return Object.keys(cookies).map(function (name) {
    return name + "=" + cookies[name];
  }).join("; ");
};

SessionStore.prototype.capture = function (baseUrl, setCookieHeaders) {
  var jar = this.jarFor(baseUrl);
  var headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : (setCookieHeaders ? [setCookieHeaders] : []);
  var changed = false;

  headers.forEach(function (line) {
    var cookie = parseSetCookie(line);
    if (!cookie) return;
    if (cookie.remove) delete jar.cookies[cookie.name];
    else jar.cookies[cookie.name] = cookie.value;
    changed = true;
  });

  if (changed) {
    jar.updatedAt = Date.now();
    this.save();
  }
};

SessionStore.prototype.clear = function (baseUrl) {
  delete this.data.origins[originOf(baseUrl)];
  this.save();
};

SessionStore.prototype.cookieKeys = function (baseUrl) {
  return Object.keys(this.jarFor(baseUrl).cookies);
};

module.exports = {
  SessionStore: SessionStore,
  originOf: originOf,
  parseSetCookie: parseSetCookie
};
