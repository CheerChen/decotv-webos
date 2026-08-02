#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets"]
# ///
"""On-device smoke test: does the app render, is it navigable, does it come back.

Run this after every deploy. It is deliberately shallow — it does not try to be
a test suite, it answers "is this build fundamentally broken on real hardware".
The checks are the failure modes that have actually shipped: a screen that
renders no content, posters that 404, a focus ring the user cannot find, and a
route that will not come back (0.3.17 tab switching, 0.3.15 race guard).

Uncaught-exception capture starts once the CDP session attaches, so errors
thrown during boot are only seen with --relaunch (which attaches to the fresh
target). A screenshot is always written: DOM assertions cannot see clipping,
z-order or a blank GPU layer.

Usage:
  uv run scripts/tv_smoke.py --relaunch
  uv run scripts/tv_smoke.py --screenshot /tmp/smoke.png
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

MIN_FOCUSABLE = 20
SCRIPT_DIR = Path(__file__).resolve().parent

KEYS = {
    "up": (38, "ArrowUp", "ArrowUp"),
    "down": (40, "ArrowDown", "ArrowDown"),
    "right": (39, "ArrowRight", "ArrowRight"),
    "ok": (13, "Enter", "Enter"),
    "back": (461, "", ""),
}

PROBE = """(function () {
  var focusable = document.querySelectorAll('.focusable');
  var focused = document.querySelectorAll('.focusable.focused');
  var broken = [];
  var imgs = document.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    if (imgs[i].complete && imgs[i].naturalWidth === 0) broken.push(imgs[i].src.slice(-60));
  }
  var posterPending = document.querySelectorAll('img[data-poster], img[data-poster-state="pending"]').length;
  var posterFailed = document.querySelectorAll('img[data-poster-state="failed"]').length;
  var f = focused[0];
  return {
    screen: (window.__router && window.__router.current) || null,
    focusable: focusable.length,
    focusedCount: focused.length,
    focusedAction: f ? f.getAttribute('data-action') : null,
    images: imgs.length,
    posterPending: posterPending,
    posterFailed: posterFailed,
    broken: broken.slice(0, 5)
  };
})()"""


def list_pages(port: int) -> list[dict]:
    with urllib.request.urlopen(f"http://localhost:{port}/json", timeout=5) as resp:
        return json.loads(resp.read())


def find_target(port: int, needle: str, wait_s: float = 0.0) -> dict | None:
    deadline = time.time() + wait_s
    while True:
        try:
            for p in list_pages(port):
                hay = " ".join([p.get("title") or "", p.get("url") or ""]).lower()
                if needle.lower() in hay:
                    return p
        except Exception:
            pass
        if time.time() >= deadline:
            return None
        time.sleep(1)


class Report:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, ok: bool, name: str, detail: str = "") -> bool:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
        if not ok:
            self.failures.append(name)
        return ok


async def run(ws_url: str, shot: Path, report: Report) -> None:
    import websockets

    msg_id = 0
    exceptions: list[str] = []

    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        pending: dict[int, asyncio.Future] = {}

        async def pump() -> None:
            async for raw in ws:
                m = json.loads(raw)
                if m.get("method") == "Runtime.exceptionThrown":
                    d = m["params"]["exceptionDetails"]
                    exceptions.append(d.get("text", "") + " " + str(d.get("exception", {}).get("description", ""))[:160])
                elif m.get("id") in pending:
                    pending.pop(m["id"]).set_result(m)

        pumper = asyncio.create_task(pump())

        async def call(method: str, params: dict | None = None) -> dict:
            nonlocal msg_id
            msg_id += 1
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            pending[msg_id] = fut
            payload: dict = {"id": msg_id, "method": method}
            if params is not None:
                payload["params"] = params
            await ws.send(json.dumps(payload))
            m = await asyncio.wait_for(fut, timeout=20)
            if m.get("error"):
                raise SystemExit(f"CDP error on {method}: {m['error']}")
            return m.get("result", {})

        async def probe() -> dict:
            r = await call("Runtime.evaluate", {"expression": PROBE, "returnByValue": True})
            return r["result"]["value"]

        async def press(name: str, settle: float = 1.2) -> None:
            vk, key, code = KEYS[name]
            base = {"windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "key": key, "code": code}
            await call("Input.dispatchKeyEvent", {"type": "rawKeyDown", **base})
            await call("Input.dispatchKeyEvent", {"type": "keyUp", **base})
            await asyncio.sleep(settle)

        await call("Runtime.enable")
        await call("Page.enable")

        print("render")
        s = await probe()
        deadline = asyncio.get_running_loop().time() + 25
        while s["posterPending"] and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.5)
            s = await probe()
        report.check(s["screen"] == "home", "lands on home", f"screen={s['screen']}")
        report.check(s["focusable"] >= MIN_FOCUSABLE, "content rendered", f"{s['focusable']} focusable")
        report.check(s["posterPending"] == 0, "poster loading settled", f"{s['posterPending']} pending")
        report.check(s["posterFailed"] == 0, "no failed posters", f"{s['posterFailed']} failed")
        report.check(not s["broken"], "no broken images", f"{len(s['broken'])}/{s['images']} broken {s['broken']}")
        # Every screen must show exactly one focus ring at all times, including
        # before the first key press — otherwise the user has to press a
        # direction blind to find out where they are.
        report.check(s["focusedCount"] == 1, "exactly one focus ring on arrival", f"count={s['focusedCount']}")

        print("navigate")
        await press("right")
        await press("down")
        s = await probe()
        report.check(s["focusedCount"] == 1, "focus follows d-pad", f"count={s['focusedCount']} on {s['focusedAction']}")

        await press("ok", settle=4.0)
        s = await probe()
        entered = report.check(s["screen"] == "detail", "OK opens detail", f"screen={s['screen']}")
        report.check(s["focusedCount"] == 1, "detail arrives focused", f"count={s['focusedCount']}")

        if entered:
            await press("back", settle=3.0)
            s = await probe()
            report.check(s["screen"] == "home", "Back returns home", f"screen={s['screen']}")

        report.check(not exceptions, "no uncaught exceptions", "; ".join(exceptions[:3]))

        r = await call("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        shot.parent.mkdir(parents=True, exist_ok=True)
        shot.write_bytes(base64.b64decode(r["data"]))
        print(f"\nscreenshot: {shot} — look at it, the DOM cannot see clipping or a blank layer")

        pumper.cancel()


def main() -> None:
    ap = argparse.ArgumentParser(description="On-device smoke test over CDP")
    ap.add_argument("--port", type=int, default=9977, help="Local CDP forward port")
    ap.add_argument("--target", default="decotv", help="Substring match on title/url")
    ap.add_argument("--relaunch", action="store_true", help="Restart the app first (needed to see boot errors)")
    ap.add_argument("--screenshot", type=Path, default=Path("/tmp/decotv_smoke.png"))
    args = ap.parse_args()

    if args.relaunch:
        print("relaunching…")
        subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "tv_luna.py"), "--relaunch"],
            check=True, capture_output=True,
        )

    target = find_target(args.port, args.target, wait_s=25 if args.relaunch else 0)
    if not target:
        print(
            f"ERROR: no CDP target matching {args.target!r} on localhost:{args.port}\n"
            f"  Tunnel: ssh -f -N -L {args.port}:localhost:9998 lgtv\n"
            f"  Launch: uv run scripts/tv_luna.py --relaunch",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.relaunch:
        time.sleep(6)  # let the home rails finish their first fetch

    print(f"target: {target.get('title')} | {target.get('url')}\n")
    report = Report()
    asyncio.run(run(target["webSocketDebuggerUrl"], args.screenshot, report))

    print()
    if report.failures:
        print(f"SMOKE FAIL ({len(report.failures)}): {', '.join(report.failures)}")
        sys.exit(1)
    print("SMOKE PASS")


if __name__ == "__main__":
    main()
