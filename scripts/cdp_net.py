#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets"]
# ///
"""Run JavaScript in DecoTV while capturing CDP cookie decisions.

The output redacts cookie values but preserves Set-Cookie attributes,
blockedReasons, and associated-cookie reasons.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request


def find_target(port: int, needle: str) -> dict:
    with urllib.request.urlopen(f"http://localhost:{port}/json", timeout=5) as response:
        pages = json.loads(response.read())
    for page in pages:
        haystack = " ".join([
            page.get("title") or "",
            page.get("description") or "",
            page.get("url") or "",
        ]).lower()
        if needle.lower() in haystack:
            return page
    raise SystemExit(f"no CDP target matching {needle!r}")


def redact_set_cookie(value: str) -> list[str]:
    redacted = []
    for line in value.splitlines():
        first, separator, attributes = line.partition(";")
        name = first.partition("=")[0].strip() or "?"
        redacted.append(f"{name}=<redacted>{separator}{attributes}")
    return redacted


async def capture(ws_url: str, expression: str, settle: float) -> dict:
    import websockets

    message_id = 0
    pending: dict[int, asyncio.Future] = {}
    requests: dict[str, dict] = {}

    async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        async def pump() -> None:
            async for raw in ws:
                event = json.loads(raw)
                if event.get("id") in pending:
                    pending.pop(event["id"]).set_result(event)
                    continue

                method = event.get("method")
                params = event.get("params", {})
                request_id = params.get("requestId")
                if not request_id:
                    continue
                row = requests.setdefault(request_id, {})

                if method == "Network.requestWillBeSent":
                    row["url"] = params.get("request", {}).get("url")
                    row["method"] = params.get("request", {}).get("method")
                elif method == "Network.responseReceived":
                    row["status"] = params.get("response", {}).get("status")
                elif method == "Network.requestWillBeSentExtraInfo":
                    row["associatedCookies"] = [
                        {
                            "name": item.get("cookie", {}).get("name"),
                            "blockedReasons": item.get("blockedReasons", []),
                        }
                        for item in params.get("associatedCookies", [])
                    ]
                elif method == "Network.responseReceivedExtraInfo":
                    headers = params.get("headers", {})
                    set_cookie = headers.get("set-cookie") or headers.get("Set-Cookie")
                    if set_cookie:
                        row["setCookie"] = redact_set_cookie(set_cookie)
                    row["blockedCookies"] = [
                        {
                            "cookie": redact_set_cookie(item.get("cookieLine", "")),
                            "blockedReasons": item.get("blockedReasons", []),
                        }
                        for item in params.get("blockedCookies", [])
                    ]

        reader = asyncio.create_task(pump())

        async def call(method: str, params: dict | None = None) -> dict:
            nonlocal message_id
            message_id += 1
            future = asyncio.get_running_loop().create_future()
            pending[message_id] = future
            payload = {"id": message_id, "method": method}
            if params is not None:
                payload["params"] = params
            await ws.send(json.dumps(payload))
            response = await asyncio.wait_for(future, timeout=30)
            if response.get("error"):
                raise RuntimeError(f"{method}: {response['error']}")
            return response.get("result", {})

        await call("Network.enable")
        await call("Runtime.enable")
        evaluated = await call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        })
        await asyncio.sleep(settle)
        reader.cancel()

    result = evaluated.get("result", {})
    return {
        "evaluation": result.get("value") if result.get("type") != "undefined" else None,
        "requests": [row for row in requests.values() if row.get("url")],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("expression", nargs="?")
    parser.add_argument("--port", type=int, default=9977)
    parser.add_argument("--target", default="decotv")
    parser.add_argument("--settle", type=float, default=1.5)
    args = parser.parse_args()
    expression = args.expression or sys.stdin.read().strip()
    if not expression:
        raise SystemExit("JavaScript expression required")
    target = find_target(args.port, args.target)
    result = asyncio.run(capture(target["webSocketDebuggerUrl"], expression, args.settle))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
