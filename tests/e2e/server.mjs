// tests/e2e/server.mjs — tiny static server for the app + test assets.
// /api/* must never reach this server (Playwright routes intercept them);
// if one does, answer 500 loudly so the mistake is visible in the test.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PORT = 4173;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unmocked /api request reached the static server: " + url.pathname }));
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(filePath);
      const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
      // Byte ranges make the test videos seekable; without them Chromium
      // reports seekable [0, 0] and every currentTime write snaps back to 0.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (range && (range[1] || range[2])) {
        const size = body.length;
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "content-type": type,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-length": end - start + 1,
        });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found: " + pathname);
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`e2e static server on http://127.0.0.1:${PORT}`);
  });
