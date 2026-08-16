// Luna transport for authenticated DecoTV API calls.
//
// A webOS app runs from file://, so the browser cannot keep DecoTV's
// cross-site SameSite=Lax auth cookie. The bundled JS service performs the
// HTTP request outside Chromium, persists Set-Cookie, and injects Cookie on
// later requests.

export const DECOTV_SERVICE = "com.cheerchen.decotv.service";

export function hasLunaTransport() {
  return Boolean(
    typeof window !== "undefined" &&
    window.webOS?.service?.request
  );
}

export class LunaResponse {
  constructor(result) {
    this.status = Number(result.status || 0);
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? (result.contentType || "")
          : null;
      }
    };
    this._body = result.body || "";
  }

  async json() {
    return JSON.parse(this._body || "null");
  }

  async text() {
    return this._body;
  }
}

function serviceCall(method, parameters, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
      request = null;
    };

    const onAbort = () => {
      try { request?.cancel?.(); } catch (_) {}
      const error = new Error("ABORTED");
      error.name = "AbortError";
      finish(reject, error);
    };

    const timer = setTimeout(() => {
      try { request?.cancel?.(); } catch (_) {}
      finish(reject, new Error("TIMEOUT"));
    }, Math.max(1000, timeoutMs));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    request = window.webOS.service.request(`luna://${DECOTV_SERVICE}`, {
      method,
      parameters,
      onSuccess(result) {
        finish(resolve, result);
      },
      onFailure(error) {
        finish(reject, new Error(error?.errorText || error?.error || "LUNA_REQUEST_FAILED"));
      }
    });
  });
}

export async function lunaFetch(baseUrl, path, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const result = await serviceCall("request", {
    baseUrl,
    path,
    method: options.method || "GET",
    contentType: options.headers?.["Content-Type"] || options.headers?.["content-type"] || "",
    body: options.body || "",
    timeoutMs
  }, {
    signal: options.signal,
    // Leave time for the service to report its own upstream timeout first.
    timeoutMs: timeoutMs > 0 ? timeoutMs + 3000 : 63000
  });

  if (!result?.returnValue) {
    throw new Error(result?.error || "LUNA_REQUEST_FAILED");
  }
  return new LunaResponse(result);
}

// Poster bytes, fetched through the service's authenticated proxy/cache
// pipeline. Base64 is used because Luna carries JSON and the service's cache
// directory is not readable by the webview.
export async function lunaFetchImage(baseUrl, url) {
  const result = await serviceCall(
    "fetchImage",
    { baseUrl, url },
    // A confirmed proxy failure may be followed by a direct request. Each
    // network leg has a 15-second service timeout, so the Luna caller must
    // leave enough room for both legs to finish and report their real error.
    { timeoutMs: 40000 }
  );
  if (!result?.returnValue || !result.base64) {
    throw new Error(result?.error || "IMAGE_FETCH_FAILED");
  }
  return {
    base64: result.base64,
    contentType: result.contentType || "image/jpeg",
    source: result.source || ""
  };
}

// Sidecar fetch: TMDB catalog sidecar, no auth cookie. Same Luna bus
// call shape as lunaFetch but routed to the fetchSidecar service method
// which does not enforce the /api/ prefix or session cookie.
export async function lunaSidecarFetch(baseUrl, path, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const result = await serviceCall("fetchSidecar", {
    baseUrl,
    path,
    method: options.method || "GET",
    contentType: options.headers?.["Content-Type"] || options.headers?.["content-type"] || "",
    body: options.body || "",
    responseEncoding: options.responseEncoding || "",
    timeoutMs
  }, {
    signal: options.signal,
    timeoutMs: timeoutMs > 0 ? timeoutMs + 3000 : 63000
  });

  if (!result?.returnValue) {
    throw new Error(result?.error || "LUNA_SIDECAR_FAILED");
  }
  return new LunaResponse(result);
}

// Sidecar image fetch: TMDB images via the sidecar's /api/image endpoint.
// No cookie, no Douban host allowlist. Reuses the fetchSidecar method with
// base64 response encoding — the same Buffer.concat().toString("base64")
// path that works for catalog JSON, avoiding a separate service handler
// whose base64 field gets mangled by the Luna bus.
export async function lunaSidecarFetchImage(baseUrl, url) {
  // Extract the relative path from the full URL — fetchSidecar expects
  // a path like "/api/image?url=...", not an absolute URL.
  let path = url;
  if (url.startsWith(baseUrl)) {
    path = url.slice(baseUrl.length);
  } else {
    try {
      const parsed = new URL(url);
      path = parsed.pathname + parsed.search;
    } catch (_) { /* use raw url as-is */ }
  }
  const response = await lunaSidecarFetch(baseUrl, path, {
    responseEncoding: "base64",
    timeoutMs: 40000
  });
  if (!response.ok) {
    throw new Error(`SIDECAR_IMAGE_HTTP_${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  return {
    base64: response._body,
    contentType,
    source: "sidecar"
  };
}

export async function getLunaSession(baseUrl) {
  if (!hasLunaTransport()) return { available: false, hasSession: false };
  const result = await serviceCall("diagnostics", { baseUrl });
  return {
    available: true,
    hasSession: Boolean(result?.hasSession),
    cookieKeys: Array.isArray(result?.cookieKeys) ? result.cookieKeys : [],
    images: result?.images || null
  };
}

export async function clearLunaSession(baseUrl) {
  if (!hasLunaTransport()) return;
  await serviceCall("clearSession", { baseUrl });
}
