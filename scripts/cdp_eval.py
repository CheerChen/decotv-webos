#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets"]
# ///
"""CDP eval — run JS in the live webOS app via Chrome DevTools Protocol.
Usage: echo 'JS_EXPRESSION' | uv run cdp_eval.py
Or:    cdp_eval.py 'JS_EXPRESSION'
"""
import sys, json, asyncio

async def main():
    # Find the DecoTV page target
    import urllib.request
    pages = json.loads(urllib.request.urlopen("http://localhost:9977/json").read())
    target = None
    for p in pages:
        if "decotv" in (p.get("title", "") + p.get("description", "")).lower():
            target = p
            break
    if not target:
        print("ERROR: DecoTV page not found in CDP targets", file=sys.stderr)
        sys.exit(1)

    ws_url = target["webSocketDebuggerUrl"]
    js = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read().strip()
    if not js:
        print("ERROR: no JS expression provided", file=sys.stderr)
        sys.exit(1)

    import websockets

    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        # Runtime.evaluate
        msg = {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": js,
                "awaitPromise": True,
                "returnByValue": True,
            },
        }
        await ws.send(json.dumps(msg))
        resp = json.loads(await ws.recv())
        if resp.get("error"):
            print(json.dumps(resp["error"], indent=2), file=sys.stderr)
            sys.exit(1)
        result = resp.get("result", {}).get("result", {})
        if result.get("type") == "undefined":
            print("undefined")
        else:
            print(json.dumps(result.get("value"), indent=2, ensure_ascii=False))

asyncio.run(main())
