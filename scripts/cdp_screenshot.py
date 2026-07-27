#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets"]
# ///
"""Capture a PNG screenshot of the live webOS webview via CDP Page.captureScreenshot.

Prereqs:
  1. SSH tunnel:  ssh -f -N -L 9977:localhost:9998 <tv-host>
  2. App running on TV (launch if needed)

Usage:
  uv run scripts/cdp_screenshot.py assets/screenshots/home.png
  uv run scripts/cdp_screenshot.py assets/screenshots/player.png --target decotv --port 9977
  # navigate then capture:
  uv run scripts/cdp_eval.py 'window.__router?.navigate("home")'
  uv run scripts/cdp_screenshot.py assets/screenshots/home.png
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import urllib.request
from pathlib import Path


def list_pages(port: int) -> list[dict]:
    url = f"http://localhost:{port}/json"
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read())


def pick_target(pages: list[dict], needle: str) -> dict | None:
    needle = (needle or "").lower()
    if not needle:
        return pages[0] if pages else None
    for p in pages:
        hay = " ".join(
            [
                p.get("title") or "",
                p.get("url") or "",
                p.get("description") or "",
            ]
        ).lower()
        if needle in hay:
            return p
    return None


async def capture(ws_url: str, out: Path, quality: int, full_page: bool) -> None:
    import websockets

    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        async def call(msg_id: int, method: str, params: dict | None = None) -> dict:
            payload = {"id": msg_id, "method": method}
            if params is not None:
                payload["params"] = params
            await ws.send(json.dumps(payload))
            while True:
                raw = json.loads(await ws.recv())
                if raw.get("id") == msg_id:
                    return raw

        await call(1, "Page.enable")
        result = await call(
            2,
            "Page.captureScreenshot",
            {
                "format": "png",
                "quality": quality,
                "fromSurface": True,
                "captureBeyondViewport": full_page,
            },
        )
        if result.get("error"):
            print(json.dumps(result["error"], indent=2), file=sys.stderr)
            sys.exit(1)
        data_b64 = result.get("result", {}).get("data")
        if not data_b64:
            print("ERROR: empty screenshot data", file=sys.stderr)
            sys.exit(1)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(data_b64))
        print(f"OK {out} ({out.stat().st_size} bytes)")


def main() -> None:
    ap = argparse.ArgumentParser(description="CDP Page.captureScreenshot → PNG")
    ap.add_argument("output", type=Path, help="Output PNG path")
    ap.add_argument("--port", type=int, default=9977, help="Local CDP forward port")
    ap.add_argument(
        "--target",
        default="decotv",
        help="Substring match on title/url (empty = first page)",
    )
    ap.add_argument("--quality", type=int, default=100)
    ap.add_argument(
        "--full-page",
        action="store_true",
        help="captureBeyondViewport (may be large)",
    )
    args = ap.parse_args()

    try:
        pages = list_pages(args.port)
    except Exception as e:
        print(
            f"ERROR: cannot reach CDP on localhost:{args.port} ({e})\n"
            f"  Start tunnel: ssh -f -N -L {args.port}:localhost:9998 <tv-host>\n"
            f"  Launch app, then retry.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not pages:
        print("ERROR: CDP /json is empty — launch the app on the TV first", file=sys.stderr)
        sys.exit(1)

    target = pick_target(pages, args.target)
    if not target:
        titles = [p.get("title") or p.get("url") for p in pages]
        print(f"ERROR: no target matching {args.target!r}. pages={titles}", file=sys.stderr)
        sys.exit(1)

    print(f"target: {target.get('title')} | {target.get('url')}", file=sys.stderr)
    asyncio.run(capture(target["webSocketDebuggerUrl"], args.output, args.quality, args.full_page))


if __name__ == "__main__":
    main()
