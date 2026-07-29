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

// Poster bytes, fetched by the service straight from the image host. Base64
// because Luna carries JSON, and because the service is jailed away from any
// directory the webview is allowed to read from disk.
export async function lunaFetchImage(url) {
  const result = await serviceCall("fetchImage", { url }, { timeoutMs: 20000 });
  if (!result?.returnValue || !result.base64) {
    throw new Error(result?.error || "IMAGE_FETCH_FAILED");
  }
  return { base64: result.base64, contentType: result.contentType || "image/jpeg" };
}

export async function getLunaSession(baseUrl) {
  if (!hasLunaTransport()) return { available: false, hasSession: false };
  const result = await serviceCall("diagnostics", { baseUrl });
  return {
    available: true,
    hasSession: Boolean(result?.hasSession),
    cookieKeys: Array.isArray(result?.cookieKeys) ? result.cookieKeys : []
  };
}

export async function clearLunaSession(baseUrl) {
  if (!hasLunaTransport()) return;
  await serviceCall("clearSession", { baseUrl });
}
