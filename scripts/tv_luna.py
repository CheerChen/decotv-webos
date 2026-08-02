#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""Send a Luna bus call to the TV over Telnet, and (re)launch the app.

Luna calls MUST go over Telnet (port 23), not SSH. SSH/dropbear runs under the
`com.palm.service.devmode` appId, whose Luna role only permits outbound calls to
`com.palm.systemservice`; ls-hubd silently drops everything else, so `luna-send`
over SSH exits 0 with no output and looks like a hang rather than a denial.
Telnet runs under `org.webosbrew.hbchannel.service`, which has wide outbound
permissions. This only applies to rooted TVs — on a plain developer-mode TV use
`ares-launch` instead.

The host defaults to whatever `ssh -G <--ssh-host>` resolves, so it follows
~/.ssh/config instead of hardcoding an IP.

Usage:
  uv run scripts/tv_luna.py --relaunch                    # close + launch DecoTV
  uv run scripts/tv_luna.py --launch com.cheerchen.decotv
  uv run scripts/tv_luna.py --call luna://com.webos.service.applicationManager/getForegroundAppInfo '{}'
  uv run scripts/tv_luna.py --sh 'ls /media/developer/apps/usr/palm/applications'
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time

APP_ID = "com.cheerchen.decotv"


def resolve_host(ssh_host: str) -> str:
    out = subprocess.run(["ssh", "-G", ssh_host], capture_output=True, text=True, timeout=10).stdout
    for line in out.splitlines():
        if line.startswith("hostname "):
            return line.split(None, 1)[1].strip()
    raise SystemExit(f"ERROR: cannot resolve host for ssh alias {ssh_host!r}")


def telnet_run(host: str, commands: list[str], settle: float) -> str:
    s = socket.create_connection((host, 23), timeout=20)
    time.sleep(1.5)
    s.settimeout(3)
    try:
        s.recv(65535)  # drain the shell banner
    except OSError:
        pass
    out = b""
    for cmd in commands:
        s.sendall((cmd + "\n").encode())
        time.sleep(settle)
        try:
            while True:
                chunk = s.recv(65535)
                if not chunk:
                    break
                out += chunk
        except OSError:
            pass
    s.close()
    return out.decode("utf-8", "replace")


def main() -> None:
    ap = argparse.ArgumentParser(description="Luna call / app relaunch over Telnet")
    ap.add_argument("--ssh-host", default="lgtv", help="~/.ssh/config alias used to resolve the IP")
    ap.add_argument("--host", help="TV IP (overrides --ssh-host resolution)")
    ap.add_argument("--settle", type=float, default=3.0, help="Seconds to wait for output per command")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--relaunch", action="store_true", help=f"closeByAppId + launch {APP_ID}")
    g.add_argument("--launch", metavar="APP_ID", help="Launch an app id")
    g.add_argument("--close", metavar="APP_ID", help="Close an app id")
    g.add_argument("--call", nargs=2, metavar=("URI", "PAYLOAD"), help="Raw luna-send call")
    g.add_argument("--sh", metavar="CMD", help="Run a shell command in the Telnet session")
    args = ap.parse_args()

    host = args.host or resolve_host(args.ssh_host)
    am = "luna://com.webos.service.applicationManager"

    if args.relaunch:
        # A webview's Luna identity is fixed at process start, and a `launch` on
        # an already-running app only foregrounds it — so a real restart has to
        # close first. The pause lets SAM finish tearing the WAM process down
        # before the new one starts, otherwise the CDP target list still shows
        # the old page.
        cmds = [
            f'luna-send -n 1 -f {am}/closeByAppId \'{{"id":"{APP_ID}"}}\'',
            "sleep 2",
            f'luna-send -n 1 -f {am}/launch \'{{"id":"{APP_ID}"}}\'',
        ]
    elif args.launch:
        cmds = [f'luna-send -n 1 -f {am}/launch \'{{"id":"{args.launch}"}}\'']
    elif args.close:
        cmds = [f'luna-send -n 1 -f {am}/closeByAppId \'{{"id":"{args.close}"}}\'']
    elif args.call:
        uri, payload = args.call
        cmds = [f"luna-send -n 1 -f {uri} '{payload}'"]
    else:
        cmds = [args.sh]

    print(f"tv: {host}", file=sys.stderr)
    print(telnet_run(host, cmds, args.settle))


if __name__ == "__main__":
    main()
