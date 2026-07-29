#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets"]
# ///
"""Drive the app with remote-control key presses via CDP Input.dispatchKeyEvent.

Focus and navigation regressions (0.3.15 race guard, 0.3.17 same-route tab
switching) can only be caught by actually walking the UI, and cdp_eval.py's
synthetic KeyboardEvents do not exercise the real input path. These are trusted
events dispatched by the browser, so they reach focusEngine exactly as the
Magic Remote's do.

Key names accepted (case-insensitive), matching what focusEngine handles:
  up down left right  ok/enter  back  0-9  a-z
A trailing ':<ms>' overrides the inter-key delay for that key, e.g. 'ok:1500'.

Usage:
  uv run scripts/cdp_keys.py down down right ok
  uv run scripts/cdp_keys.py "down,down,right,ok:1500,back"
  uv run scripts/cdp_keys.py --delay 500 right right
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request

# windowsVirtualKeyCode, key, code. webOS delivers Back as keyCode 461 with no
# meaningful `key` string — focusEngine.isBackKey() matches on the numeric code,
# so leaving key/code empty here mirrors the real device rather than papering
# over it with a synthetic 'GoBack'.
KEYS: dict[str, tuple[int, str, str]] = {
    "up": (38, "ArrowUp", "ArrowUp"),
    "down": (40, "ArrowDown", "ArrowDown"),
    "left": (37, "ArrowLeft", "ArrowLeft"),
    "right": (39, "ArrowRight", "ArrowRight"),
    "ok": (13, "Enter", "Enter"),
    "enter": (13, "Enter", "Enter"),
    "back": (461, "", ""),
    "esc": (27, "Escape", "Escape"),
    "play": (415, "MediaPlay", ""),
    "pause": (19, "MediaPause", ""),
}
for _d in range(10):
    KEYS[str(_d)] = (48 + _d, str(_d), f"Digit{_d}")
for _c in "abcdefghijklmnopqrstuvwxyz":
    KEYS[_c] = (ord(_c.upper()), _c, f"Key{_c.upper()}")


def parse_keys(tokens: list[str], default_delay: int) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for token in tokens:
        for part in token.split(","):
            part = part.strip()
            if not part:
                continue
            name, _, delay = part.partition(":")
            name = name.lower()
            if name not in KEYS:
                raise SystemExit(f"ERROR: unknown key {name!r}. known: {', '.join(sorted(KEYS))}")
            out.append((name, int(delay) if delay else default_delay))
    if not out:
        raise SystemExit("ERROR: no keys given")
    return out


def list_pages(port: int) -> list[dict]:
    with urllib.request.urlopen(f"http://localhost:{port}/json", timeout=5) as resp:
        return json.loads(resp.read())


def pick_target(pages: list[dict], needle: str) -> dict | None:
    needle = (needle or "").lower()
    if not needle:
        return pages[0] if pages else None
    for p in pages:
        hay = " ".join([p.get("title") or "", p.get("url") or "", p.get("description") or ""]).lower()
        if needle in hay:
            return p
    return None


async def drive(ws_url: str, keys: list[tuple[str, int]], report: bool) -> None:
    import websockets

    msg_id = 0

    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        async def call(method: str, params: dict | None = None) -> dict:
            nonlocal msg_id
            msg_id += 1
            mine = msg_id
            payload: dict = {"id": mine, "method": method}
            if params is not None:
                payload["params"] = params
            await ws.send(json.dumps(payload))
            while True:
                raw = json.loads(await ws.recv())
                if raw.get("id") == mine:
                    if raw.get("error"):
                        raise SystemExit(f"CDP error on {method}: {raw['error']}")
                    return raw.get("result", {})

        for name, delay in keys:
            vk, key, code = KEYS[name]
            # rawKeyDown (not keyDown) for non-text keys: keyDown makes Chromium
            # expect a matching `text`, and Enter would then also generate a
            # synthetic click that fires the focused action twice.
            base = {"windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "key": key, "code": code}
            await call("Input.dispatchKeyEvent", {"type": "rawKeyDown", **base})
            await call("Input.dispatchKeyEvent", {"type": "keyUp", **base})
            print(f"  {name}", file=sys.stderr)
            await asyncio.sleep(delay / 1000)

        if report:
            expr = """(function () {
  var f = document.querySelector('.focusable.focused');
  return JSON.stringify({
    screen: (window.__router && window.__router.current) || '?',
    focused: f ? (f.getAttribute('data-action') || f.className) : null,
    label: f ? (f.textContent || '').trim().slice(0, 40) : null,
    focusable: document.querySelectorAll('.focusable').length
  });
})()"""
            res = await call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            print(res.get("result", {}).get("value", "{}"))


def main() -> None:
    ap = argparse.ArgumentParser(description="Send remote-control keys to the app over CDP")
    ap.add_argument("keys", nargs="+", help="Key names, space- or comma-separated")
    ap.add_argument("--port", type=int, default=9977, help="Local CDP forward port")
    ap.add_argument("--target", default="decotv", help="Substring match on title/url")
    ap.add_argument("--delay", type=int, default=350, help="Default ms between keys")
    ap.add_argument("--no-report", action="store_true", help="Skip the trailing focus report")
    args = ap.parse_args()

    keys = parse_keys(args.keys, args.delay)

    try:
        pages = list_pages(args.port)
    except Exception as e:
        print(
            f"ERROR: cannot reach CDP on localhost:{args.port} ({e})\n"
            f"  Start tunnel: ssh -f -N -L {args.port}:localhost:9998 <tv-host>",
            file=sys.stderr,
        )
        sys.exit(1)

    target = pick_target(pages, args.target)
    if not target:
        titles = [p.get("title") or p.get("url") for p in pages]
        print(f"ERROR: no target matching {args.target!r}. pages={titles}", file=sys.stderr)
        sys.exit(1)

    print(f"target: {target.get('title')} | {target.get('url')}", file=sys.stderr)
    asyncio.run(drive(target["webSocketDebuggerUrl"], keys, not args.no_report))


if __name__ == "__main__":
    main()
