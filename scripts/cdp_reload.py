#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets"]
# ///
"""CDP reload — reload the live webOS app page via Chrome DevTools Protocol.
No reboot, no close/launch — just reloads the file:// page in-place.
"""
import sys, json, asyncio, urllib.request

async def main():
    pages = json.loads(urllib.request.urlopen("http://localhost:9977/json").read())
    target = None
    for p in pages:
        if "decotv" in (p.get("title", "") + p.get("description", "")).lower():
            target = p
            break
    if not target:
        print("ERROR: DecoTV page not found in CDP targets", file=sys.stderr)
        sys.exit(1)

    import websockets
    ws_url = target["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        # Page.reload — reloads the current page (file://) in-place
        msg = {"id": 1, "method": "Page.reload", "params": {"ignoreCache": True}}
        await ws.send(json.dumps(msg))
        resp = json.loads(await ws.recv())
        if resp.get("error"):
            print(json.dumps(resp["error"], indent=2), file=sys.stderr)
            sys.exit(1)
        print("Page.reload OK — app reloaded from file://")

asyncio.run(main())
