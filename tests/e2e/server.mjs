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
      res.writeHead(200, { "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found: " + pathname);
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`e2e static server on http://127.0.0.1:${PORT}`);
  });
