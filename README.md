# DecoTV for webOS

A lightweight [DecoTV](https://github.com/Decohererk/DecoTV) client for LG webOS
TVs. Browse the Douban-powered catalog, search, auto-pick the best playback
source, and watch — all driven by the TV remote.

## Requirements

- **The DecoTV server must run in `public` auth mode** (`NEXT_PUBLIC_AUTH_MODE=public`).

  This app only supports public-mode servers. On a public server, browsing,
  search, source probing and playback all work without an account, which is all
  a TV client needs. If you point the app at a non-public server (`password`
  mode), it will show a friendly notice on the server screen and ask you to
  switch the server to `public` — it will **not** try to log in.

  > **Why not account login?** DecoTV authenticates with a `SameSite=Lax` session
  > cookie. A webOS app is loaded from a `file://` origin, so every request to
  > the server is cross-site. The TV's webview refuses to store that cookie
  > (Chromium blocks it with `SameSiteLax`), and — unlike a native app — a
  > webview cannot read `Set-Cookie` or set a `Cookie` request header to work
  > around it. So account-scoped, server-synced data is not reachable from a
  > `file://` webOS app against a stock DecoTV server. Public mode sidesteps this
  > entirely.

## Favorites & play records are stored on the TV

Because account endpoints are unreachable (see above), **favorites, play
progress and watch history are kept locally on the TV** (in `localStorage`).

- ✅ The TV remembers what you favorited, resumes where you left off, and keeps
  a "播放记录" (history) list.
- ⚠️ This data is **per-device** — it does **not** sync with the DecoTV web UI
  or other devices.

## Features

- Douban catalog wall, search, and PC-style "prefer best source" (probe every
  source, rank by quality/speed, auto-play the best).
- Resume playback from where you stopped; auto-add watched titles to history.
- In-player source switching and episode list.
- D-pad + Back remote navigation; static launch splash (no boot spinner).

## Build & install (rooted / dev-mode webOS)

```bash
# Package (the -n / --no-minify flag is required: the source ships as native
# ES modules, which the bundled minifier cannot process).
ares-package . -n
# → com.cheerchen.decotv_<version>_all.ipk

# Sideload onto a rooted TV (scp + opkg; see the project proposal for details)
scp com.cheerchen.decotv_*_all.ipk lgtv:/tmp/decotv.ipk
ssh lgtv 'opkg --add-dest developer:/media/developer install -d developer /tmp/decotv.ipk && \
          mkdir -p /media/developer/apps/usr/palm/applications/ && \
          cp -a /media/developer/usr/palm/applications/com.cheerchen.decotv \
                /media/developer/apps/usr/palm/applications/'
ssh lgtv 'sync; reboot'   # first install: reboot so sam registers the app
```

On the first launch, enter your DecoTV server URL (e.g. `http://192.168.0.110:4000`).
