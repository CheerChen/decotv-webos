"use strict";

// m3u8AdFilter.js — pure playlist rewriter that strips dynamically-stitched
// ad segments from an HLS playlist before the player ever sees them.
//
// Used only by the on-device Luna JS service's m3u8 proxy. It had a second
// copy in the TMDB sidecar as a debug/control-group double; that copy is gone
// — it never ran in the container (the sidecar's Dockerfile copied server.js
// only), so the "control" was really a local `node server.js`, and keeping a
// duplicate in sync cost a byte-identity test and a rewrite of an unused file
// on every change here.
//
// No network, no Express, no Node-specific APIs beyond URL — usable in any
// CommonJS runtime (old webOS service Node included) and importable into ESM
// via a thin wrapper if needed later.
//
// Strategy (mirrors adSkipScanner.js but outputs rewritten text, not ranges):
//   1. Split the media playlist into #EXT-X-DISCONTINUITY groups.
//   2. Compute each group's URL signature = origin + directory (filename and
//      query stripped). Injected ad assets live in a different storage path
//      than the episode's own segments, so a group whose signature deviates
//      from the duration-weighted majority is ad material.
//   3. Delete ad groups' #EXTINF + segment lines. At each ad/content boundary
//      keep exactly one #EXT-X-DISCONTINUITY so the decoder resets its state
//      at the splice point (conservative — verified safe on webOS before
//      trying the "delete both, rely on PTS continuity" optimisation).
//   4. Rewrite every remaining segment URL via the injected rewriteUrl fn so
//      the player fetches segments through the same proxy (or direct, if the
//      caller passes an identity fn).
//
// For master playlists: rewrite each variant URL via rewriteUrl and pass the
// body through otherwise. The caller's proxy endpoint must handle both master
// and media forms (this function auto-detects).
//
// The caller injects rewriteUrl(url, { kind }) where kind is "variant" or
// "segment". For a sidecar proxy that rewrites both back to itself:
//   rewriteUrl = (u) => `${proxyBase}?url=${encodeURIComponent(u)}`
// For a passthrough/identity proxy (segments direct, only playlist proxied):
//   rewriteUrl = (u) => u

var URLCtor;
try {
  URLCtor = require("url").URL; // Node
} catch (_) {
  URLCtor = typeof URL !== "undefined" ? URL : null; // browser/global
}

// ── URL helpers ───────────────────────────────────────────────────────────

function resolveUrl(base, ref) {
  if (!URLCtor) return ref;
  try { return new URLCtor(ref, base).href; } catch (_) { return ref; }
}

// Rewrite the URI="..." attribute inside a tag line (e.g. #EXT-X-KEY,
// #EXT-X-MAP) to an absolute URL resolved against baseUrl. Without this,
// a relative URI like URI="enc.key" would be resolved against the proxy
// host (127.0.0.1:3999) by the player, not the CDN — the key fetch would
// 404 and encrypted segments would fail to decrypt.
function rewriteTagUri(tagLine, baseUrl) {
  if (!URLCtor || !baseUrl) return tagLine;
  var m = tagLine.match(/URI="([^"]*)"/);
  if (!m) return tagLine;
  var uri = m[1];
  // Already absolute — leave alone.
  if (/^https?:\/\//i.test(uri)) return tagLine;
  var abs = resolveUrl(baseUrl, uri);
  return tagLine.slice(0, m.index) + 'URI="' + abs + '"' + tagLine.slice(m.index + m[0].length);
}

// Normalize a segment URL to its origin + directory (filename and query
// stripped), e.g. https://cdn.example/2025/1107/4M/hls/a.ts →
// https://cdn.example/2025/1107/4M/hls/
function urlSignature(url) {
  if (!URLCtor) return null;
  try {
    var u = new URLCtor(url);
    var slash = u.pathname.lastIndexOf("/");
    var dir = slash < 0 ? u.pathname : u.pathname.slice(0, slash + 1);
    return u.origin + dir;
  } catch (_) { return null; }
}

// One signature for a whole group; null if any segment URL is unresolvable or
// the group spans mixed directories (then signature detection is skipped for
// it, conservative side).
function groupSignature(urls) {
  var sig = null;
  for (var i = 0; i < urls.length; i++) {
    var s = urlSignature(urls[i]);
    if (s === null) return null;
    if (sig === null) sig = s;
    else if (sig !== s) return null;
  }
  return sig;
}

// Parse an #EXT-X-KEY tag into what the segment prober needs to decrypt a
// probe window. METHOD=NONE clears the key. The key URI is resolved against
// the PLAYLIST url, per HLS — resolving it against the segment host 404s on
// real CDNs, since the key usually lives next to the playlist.
function parseKeyTag(line, baseUrl) {
  var methodMatch = line.match(/METHOD=([^,\s]+)/i);
  if (!methodMatch) return null;
  var method = methodMatch[1].toUpperCase();
  if (method === "NONE") return null;
  var uriMatch = line.match(/URI="([^"]*)"/i);
  var ivMatch = line.match(/IV=0x([0-9A-Fa-f]+)/i);
  return {
    method: method,
    uri: uriMatch ? resolveUrl(baseUrl, uriMatch[1]) : null,
    ivHex: ivMatch ? ivMatch[1].toLowerCase() : null
  };
}

// The playlist's EXT-X-MEDIA-SEQUENCE, which doubles as the default IV for
// AES-128 when the key tag carries no explicit IV.
function parseMediaSequence(text) {
  var m = String(text).match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Normalize an explicit ad-group selector (array of ordinals or an object
// keyed by ordinal) into a lookup, or null when nothing was supplied.
function indexLookup(value) {
  if (!value) return null;
  var lookup = {};
  var found = false;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) { lookup[value[i]] = true; found = true; }
  } else {
    for (var key in value) {
      if (value[key]) { lookup[key] = true; found = true; }
    }
  }
  return found ? lookup : null;
}

// ── Media playlist rewrite ────────────────────────────────────────────────

// Parse into a line model that preserves enough structure to rewrite in
// place. Each "item" is either a tag line or a segment block (EXTINF + url).
function parseMediaLines(text, baseUrl) {
  var rawLines = String(text).split(/\r?\n/);
  var lines = [];
  for (var i = 0; i < rawLines.length; i++) {
    lines.push(rawLines[i].trim());
  }
  // Build a structured list: header tags, discontinuity markers, segment
  // blocks (EXTINF lines + the url line that follows), and other tags.
  var items = [];
  var activeKey = null; // last #EXT-X-KEY seen — applies to later segments
  var j = 0;
  while (j < lines.length) {
    var line = lines[j];
    if (line === "") { j++; continue; }
    if (line.indexOf("#EXT-X-DISCONTINUITY") === 0) {
      items.push({ type: "disc" });
      j++;
    } else if (line.indexOf("#EXTINF:") === 0) {
      // EXTINF may be followed by more #EXT-X-* tags before the url line
      // (e.g. #EXT-X-BYTERANGE). Collect until the first non-tag line.
      var block = { type: "seg", extinf: line, preTags: [], url: "", urlRaw: "", key: activeKey };
      j++;
      while (j < lines.length) {
        var nxt = lines[j];
        if (nxt === "") { j++; continue; }
        if (nxt.charAt(0) === "#") { block.preTags.push(nxt); j++; continue; }
        block.urlRaw = nxt;
        block.url = resolveUrl(baseUrl, nxt);
        j++;
        break;
      }
      items.push(block);
    } else {
      if (line.indexOf("#EXT-X-KEY") === 0) activeKey = parseKeyTag(line, baseUrl);
      items.push({ type: "tag", text: line });
      j++;
    }
  }
  return items;
}

// Group items by discontinuity: each group is a run of segment blocks between
// disc markers. Returns groups with their item-index range, signature, and
// the first segment's probe facts (absolute URL, media sequence number, and
// the AES-128 key in force) — everything the request-time probe needs to
// classify a group without re-parsing the playlist.
function buildGroups(items, mediaSequence) {
  var seqBase = mediaSequence || 0;
  var groups = [];
  var cur = null;
  var groupTimeOffset = 0;
  var segOrdinal = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.type === "disc") {
      cur = null; // next seg starts a new group
      continue;
    }
    if (it.type === "seg") {
      if (!cur) {
        cur = {
          index: groups.length,
          startIdx: i,
          start: groupTimeOffset,
          segs: [],
          urls: [],
          duration: 0,
          firstUrl: it.url,
          firstSeq: seqBase + segOrdinal,
          key: it.key || null
        };
        groups.push(cur);
      }
      cur.segs.push(i);
      cur.urls.push(it.url);
      var m = it.extinf.match(/#EXTINF:([\d.]+)/);
      var d = m ? parseFloat(m[1]) : 0;
      cur.duration += d;
      groupTimeOffset += d;
      segOrdinal += 1;
    }
  }
  // Attach signature
  for (var g = 0; g < groups.length; g++) {
    groups[g].sig = groupSignature(groups[g].urls);
  }
  return groups;
}

function majoritySignature(groups) {
  var scores = {};
  var total = 0;
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (g.sig === null) continue;
    scores[g.sig] = (scores[g.sig] || 0) + g.duration;
    total += g.duration;
  }
  var best = null, bestScore = 0;
  var keys = Object.keys(scores);
  for (var k = 0; k < keys.length; k++) {
    if (scores[keys[k]] > bestScore) { bestScore = scores[keys[k]]; best = keys[k]; }
  }
  // Only use signature filtering when one signature owns more than half the
  // total duration — otherwise a playlist that legitimately rotates CDN hosts
  // group-by-group would classify content groups as ads.
  var usable = best !== null && total > 0 && bestScore / total > 0.5;
  return usable ? best : null;
}

// Rewrite a media playlist: strip ad groups, keep one discontinuity at each
// splice point, rewrite remaining segment URLs via rewriteUrl.
//
// opts.rewriteUrl(url, { kind: "segment" }) → string
// opts.rewriteDisc === false to delete boundary discontinuities entirely
//   (default: keep one — conservative, verified safe on webOS).
// opts.adGroupIndices — group ordinals the caller classified as ads by some
//   other means (the request-time coded-signature probe). Applied in
//   addition to the URL-signature rule, and unlike that rule it works even
//   when no majority signature exists — which is exactly the same-directory
//   ad family the signature rule cannot see.
function rewriteMediaPlaylist(text, baseUrl, opts) {
  opts = opts || {};
  var rewriteUrl = opts.rewriteUrl || function (u) { return u; };
  var keepDisc = opts.rewriteDisc !== false;
  var explicit = indexLookup(opts.adGroupIndices);
  var items = parseMediaLines(text, baseUrl);
  var groups = buildGroups(items, parseMediaSequence(text));
  var baselineSig = majoritySignature(groups);

  // Nothing to act on: no usable majority signature and no probe verdict.
  // Return with URLs rewritten only.
  if (baselineSig === null && !explicit) {
    return emitMedia(items, rewriteUrl, baseUrl);
  }

  // Mark which item indices belong to ad groups.
  var adItems = {};
  var markGroup = function (grp) {
    for (var s = 0; s < grp.segs.length; s++) adItems[grp.segs[s]] = true;
  };
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    if (baselineSig !== null && grp.sig !== null && grp.sig !== baselineSig) {
      markGroup(grp);
    }
    if (explicit && explicit[grp.index]) markGroup(grp);
  }

  // Walk items, dropping ad segments. At each content→ad→content transition
  // emit exactly one #EXT-X-DISCONTINUITY (the splice point). Discontinuities
  // inside pure content (between two content segments with no ad between them)
  // are preserved — they mark real encoder/PTS breaks that starfish needs.
  var out = [];
  var prevWasContent = false;
  var sawAd = false;
  var pendingDisc = false; // a disc was seen and not yet consumed by an ad boundary
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.type === "seg" && adItems[i]) {
      sawAd = true;
      pendingDisc = false; // disc preceding this ad was an ad boundary, not content-internal
      continue;
    }
    if (it.type === "disc") {
      // Defer the decision: if this disc sits between two content segments
      // (no ad between them), it is a legitimate content-internal break and
      // must survive. If an ad block follows, the disc was an ad boundary
      // and gets absorbed into the splice-point disc we emit below.
      pendingDisc = true;
      continue;
    }
    // Reaching here: it's a content seg or a tag line.
    // Emit a splice discontinuity when resuming content after an ad block.
    // If there was a pending content-internal disc (no ad between), emit it
    // as-is — it marks a real PTS/encoder break the decoder needs.
    if (it.type === "seg") {
      if (sawAd && prevWasContent && keepDisc) {
        out.push("#EXT-X-DISCONTINUITY");
      } else if (pendingDisc) {
        out.push("#EXT-X-DISCONTINUITY");
      }
      sawAd = false;
      pendingDisc = false;
      prevWasContent = true;
      out.push(it.extinf);
      for (var p = 0; p < it.preTags.length; p++) out.push(it.preTags[p]);
      out.push(rewriteUrl(it.url, { kind: "segment" }));
    } else {
      // tag line (header tags, #EXT-X-ENDLIST, etc.) — do not reset sawAd
      // here so a trailing ad block followed by ENDLIST does not emit a disc.
      // A pending content-internal disc before a trailing tag is meaningless
      // (no segment after it to reset the decoder for), so drop it.
      pendingDisc = false;
      out.push(rewriteTagUri(it.text, baseUrl));
    }
  }
  return out.join("\n");
}

// Emit a media playlist with only URL rewriting (no ad stripping). Used when
// no majority signature is found.
function emitMedia(items, rewriteUrl, baseUrl) {
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.type === "disc") { out.push("#EXT-X-DISCONTINUITY"); continue; }
    if (it.type === "seg") {
      out.push(it.extinf);
      for (var p = 0; p < it.preTags.length; p++) out.push(it.preTags[p]);
      out.push(rewriteUrl(it.url, { kind: "segment" }));
      continue;
    }
    out.push(rewriteTagUri(it.text, baseUrl));
  }
  return out.join("\n");
}

// ── Master playlist rewrite ───────────────────────────────────────────────

function isMasterPlaylist(text) {
  return String(text).indexOf("#EXT-X-STREAM-INF") !== -1;
}

// Rewrite variant URLs in a master playlist via rewriteUrl. Other lines pass
// through unchanged. Relative variant URLs are resolved against baseUrl.
function rewriteMasterPlaylist(text, baseUrl, opts) {
  opts = opts || {};
  var rewriteUrl = opts.rewriteUrl || function (u) { return u; };
  var lines = String(text).split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
      out.push(lines[i]);
      // The next non-empty, non-tag line is the variant URL.
      var j = i + 1;
      while (j < lines.length && lines[j].trim() === "") { out.push(lines[j]); j++; }
      if (j < lines.length) {
        var nxt = lines[j].trim();
        if (nxt && nxt.charAt(0) !== "#") {
          var abs = resolveUrl(baseUrl, nxt);
          out.push(rewriteUrl(abs, { kind: "variant" }));
        } else {
          out.push(lines[j]);
        }
        i = j;
      }
    } else {
      out.push(rewriteTagUri(lines[i], baseUrl));
    }
  }
  return out.join("\n");
}

// ── Public entry point ────────────────────────────────────────────────────

// Auto-detect master vs media and rewrite accordingly.
//   text      — raw playlist text
//   baseUrl   — the URL the playlist was fetched from (for resolving relative
//               refs; should be the final URL after redirects)
//   opts.rewriteUrl(url, { kind }) — inject the proxy URL builder
//   opts.rewriteDisc — false to delete boundary discontinuities entirely
//                      (default: keep one)
//
// Returns the rewritten playlist text.
function filterPlaylist(text, baseUrl, opts) {
  if (isMasterPlaylist(text)) {
    return rewriteMasterPlaylist(text, baseUrl, opts);
  }
  return rewriteMediaPlaylist(text, baseUrl, opts);
}

// Compute the ad ranges that filterPlaylist would remove, on the ORIGINAL
// timeline (before compression). The caller uses this to map a resume
// position from the original timeline to the filtered timeline:
//   filteredTime = originalTime - sum(overlap of each ad range with [0, originalTime])
//
// opts.adGroupIndices must be the SAME selector passed to filterPlaylist, or
// the mapping and the rewritten playlist disagree about what was removed.
//
// Returns [] for master playlists or when nothing is removable.
function removedAdRanges(text, baseUrl, opts) {
  opts = opts || {};
  if (isMasterPlaylist(text)) return [];
  var explicit = indexLookup(opts.adGroupIndices);
  var items = parseMediaLines(text, baseUrl);
  var groups = buildGroups(items, parseMediaSequence(text));
  var baselineSig = majoritySignature(groups);
  if (baselineSig === null && !explicit) return [];
  var ranges = [];
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var isAd = (baselineSig !== null && grp.sig !== null && grp.sig !== baselineSig)
      || (explicit && explicit[grp.index]);
    if (isAd && grp.duration > 0) {
      ranges.push({ start: grp.start, end: grp.start + grp.duration });
    }
  }
  return ranges;
}

// Group analysis for the request-time probe. Pure — no network. The proxy
// reads the group list, probes the groups whose coded signature it needs,
// and hands the verdict back in as opts.adGroupIndices. Grouping, group
// signatures and the majority rule live here so the signature path and the
// probe path can never drift apart.
//
// Returns { groups, baselineSig, mediaSequence } where each group carries
// its ordinal, timeline range, item indices, first segment URL / media
// sequence number / AES key, and URL signature.
function analyzeGroups(text, baseUrl) {
  if (isMasterPlaylist(text)) {
    return { groups: [], baselineSig: null, mediaSequence: 0 };
  }
  var mediaSequence = parseMediaSequence(text);
  var groups = buildGroups(parseMediaLines(text, baseUrl), mediaSequence);
  return {
    groups: groups,
    baselineSig: majoritySignature(groups),
    mediaSequence: mediaSequence
  };
}

module.exports = {
  filterPlaylist: filterPlaylist,
  removedAdRanges: removedAdRanges,
  analyzeGroups: analyzeGroups,
  rewriteMediaPlaylist: rewriteMediaPlaylist,
  rewriteMasterPlaylist: rewriteMasterPlaylist,
  isMasterPlaylist: isMasterPlaylist,
  urlSignature: urlSignature,
  groupSignature: groupSignature,
  majoritySignature: majoritySignature,
  parseKeyTag: parseKeyTag,
  parseMediaSequence: parseMediaSequence,
};
