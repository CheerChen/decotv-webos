"use strict";

// TMDB upstream policy for the fetchTmdb service method: which paths may be
// requested, how the bundled API key is attached, and what gets cached.
//
// The key ships inside the IPK as tmdb.key (one line, gitignored), the same
// way other open-source TMDB clients embed their app key. It is not a
// secret once published; keeping it in the service only means the page
// never handles it and the repo history never contains it.
//
// ES5 + built-ins only: runs on the older Node bundled with webOS.

var fs = require("fs");
var URLCtor = require("url").URL;

var TMDB_ORIGIN = "https://api.themoviedb.org";

// A v4 "API Read Access Token" is a JWT (three dot-separated segments) and
// goes in an Authorization header; anything else is treated as a v3 api_key
// query parameter.
function credentialFor(rawKey) {
  var key = String(rawKey || "").trim();
  if (!key) return null;
  if (key.split(".").length === 3) return { type: "bearer", value: key };
  return { type: "api_key", value: key };
}

function loadCredential(keyFile) {
  try {
    return credentialFor(fs.readFileSync(keyFile, "utf8"));
  } catch (_) {
    return null;
  }
}

// Lock the request to the TMDB API origin and its /3/ namespace. The page
// must not choose api_key itself — the bundled credential is the only one.
function tmdbTargetFor(payloadPath) {
  if (typeof payloadPath !== "string" ||
      payloadPath.charAt(0) !== "/" ||
      payloadPath.slice(0, 2) === "//") {
    throw new Error("A relative path is required");
  }
  var target = new URLCtor(payloadPath, TMDB_ORIGIN);
  if (target.origin !== TMDB_ORIGIN || target.pathname.indexOf("/3/") !== 0) {
    throw new Error("Only TMDB /3/ paths are allowed");
  }
  target.searchParams.delete("api_key");
  return target;
}

// Request path and headers for a validated target. The cache key is the
// path WITHOUT the credential so a key rotation does not split the cache.
function upstreamRequest(target, credential) {
  var cacheKey = target.pathname + target.search;
  var headers = { "Accept": "application/json" };
  var requestPath = cacheKey;
  if (credential.type === "bearer") {
    headers.Authorization = "Bearer " + credential.value;
  } else {
    requestPath += (target.search ? "&" : "?") +
      "api_key=" + encodeURIComponent(credential.value);
  }
  return { cacheKey: cacheKey, path: requestPath, headers: headers };
}

// /images responses list every poster/backdrop/logo of a title (tens of KB
// each, one per card). The page persists the poster it picks, so caching
// the raw bodies here would only hold memory.
function cacheable(target) {
  return !/\/images$/.test(target.pathname);
}

module.exports = {
  TMDB_ORIGIN: TMDB_ORIGIN,
  credentialFor: credentialFor,
  loadCredential: loadCredential,
  tmdbTargetFor: tmdbTargetFor,
  upstreamRequest: upstreamRequest,
  cacheable: cacheable
};
