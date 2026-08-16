// posterImage.js — get poster artwork onto the screen.
//
// A poster cannot simply be put in an <img src>. DecoTV's /api/image-proxy is
// behind a middleware that answers 401 without the auth cookie, which a
// file:// page cannot carry; and the image hosts themselves are no better,
// because Douban answers 418 to any request without a browser Accept and a
// Referer of https://movie.douban.com/, neither of which a file:// document
// sends. Roughly nine in ten posters on the home screen come from Douban.
//
// So the bytes are fetched by the JS service through DecoTV's authenticated
// proxy, a persistent disk cache, and a tightly scoped Douban fallback. They
// arrive here as base64 and are turned into a blob URL. Screens render a
// placeholder plus the remote address and this module swaps in the real image.

import { escapeAttr } from "./utils.js";
import { api } from "../core/network/decotvClient.js";
import { tmdb } from "../core/network/tmdbClient.js";
import { hasLunaTransport, lunaFetchImage, lunaSidecarFetchImage } from "../core/network/lunaTransport.js";

// 1x1 transparent GIF: keeps layout stable and, unlike an empty src, does not
// make the webview issue a request for the document itself.
const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// Posters are ~25-95 KB each as blobs. A few hundred is a whole evening of
// browsing and still a modest amount of memory; past that the oldest go.
const MAX_CACHED = 300;
// The service fetches serially per request but happily runs several at once.
// Four keeps a poster wall filling steadily without starving API calls that
// share the same bus.
const CONCURRENCY = 4;

const cache = new Map();      // server + remote url -> blob url
const pending = new Map();    // server + remote url -> Promise<blob url>
const queue = [];
let active = 0;

function remember(key, objectUrl) {
  cache.set(key, objectUrl);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    const stale = cache.get(oldest);
    cache.delete(oldest);
    try { URL.revokeObjectURL(stale); } catch (_) {}
  }
}

function toBlobUrl(base64, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: contentType || "image/jpeg" }));
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    job().then(() => { active--; pump(); }, () => { active--; pump(); });
  }
}

function resolve(url) {
  const baseUrl = api.baseURL || api.getStoredBaseUrl() || "";
  const sidecarUrl = tmdb.resolveSidecarUrl(baseUrl);
  // Sidecar URLs (TMDB images) go through a separate fetch path that
  // does not need the DecoTV auth cookie and is not restricted to
  // Douban image hosts.
  const isSidecar = sidecarUrl && url.startsWith(sidecarUrl);
  const fetchBaseUrl = isSidecar ? sidecarUrl : baseUrl;
  const key = `${fetchBaseUrl}\0${url}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);
  const fetcher = isSidecar ? lunaSidecarFetchImage : lunaFetchImage;
  const task = new Promise((done, fail) => {
    queue.push(() => fetcher(fetchBaseUrl, url).then((result) => {
      try {
        const objectUrl = toBlobUrl(result.base64, result.contentType);
        remember(key, objectUrl);
        done(objectUrl);
      } catch (error) {
        fail(error);
        throw error;
      }
    }, (error) => {
      fail(error);
      // Rethrow is deliberate: pump() only needs to know the slot is free.
      throw error;
    }));
    pump();
  });
  pending.set(key, task);
  task.catch(() => {}).then(() => pending.delete(key));
  return task;
}

// Emitted into a template in place of `src="..."`. The address travels as a
// data attribute so the webview never tries to load it itself and waste a
// round trip discovering it is not allowed to.
export function posterAttrs(url) {
  const remote = String(url || "");
  if (!remote) return `src="${PLACEHOLDER}"`;
  // Browser preview has no service to fetch through, so it keeps the old
  // behaviour of pointing at DecoTV's own proxy. That works there because a
  // normal http:// page can hold the session cookie.
  if (!hasLunaTransport()) return `src="${escapeAttr(api.getImageProxyUrl(remote))}"`;
  return `src="${PLACEHOLDER}" data-poster="${escapeAttr(remote)}"`;
}

function hydrate(img) {
  const remote = img.dataset.poster;
  if (!remote) return;
  // Claim it first: a re-render can hand us the same element twice.
  delete img.dataset.poster;
  img.dataset.posterState = "pending";
  const loaded = () => { img.dataset.posterState = "loaded"; };
  const failed = () => {
    img.dataset.posterState = "failed";
    img.style.opacity = "0.15";
  };
  resolve(remote).then((objectUrl) => {
    // Bind only when assigning the real blob. The transparent data-URI
    // placeholder may finish after hydration begins; listening earlier would
    // mark a still-pending poster as loaded and make TV smoke tests lie.
    img.addEventListener?.("load", loaded, { once: true });
    img.addEventListener?.("error", failed, { once: true });
    img.src = objectUrl;
  }, failed);
}

export function hydratePosters(root) {
  const scope = root || document;
  scope.querySelectorAll?.("img[data-poster]").forEach(hydrate);
}

// One observer for the whole app: screens replace their innerHTML wholesale
// and from several places each, so anything that had to be called after every
// render would eventually be forgotten at one of them.
export function watchPosters() {
  hydratePosters(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.("img[data-poster]")) hydrate(node);
        else hydratePosters(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}
