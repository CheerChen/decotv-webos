<!-- markdownlint-disable MD033 MD041 -->

<p align="center">
  <img src="assets/icons/icon-large.png" alt="DecoTV" width="120" />
</p>

<h1 align="center">DecoTV for webOS</h1>

<p align="center">
  <strong>Native <a href="https://github.com/Decohererk/DecoTV">DecoTV</a> client for LG webOS TVs</strong><br />
  Douban catalog · multi-source probe ranking · full D-pad navigation · hardware decode
</p>

<p align="center">
  <a href="README.md"><b>中文</b></a>
  &nbsp;·&nbsp;
  <b>English</b>
</p>

<p align="center">
  <a href="https://github.com/CheerChen/decotv-webos/stargazers"><img src="https://img.shields.io/github/stars/CheerChen/decotv-webos?style=flat&logo=github" alt="Stars" /></a>
  <a href="https://github.com/CheerChen/decotv-webos/releases"><img src="https://img.shields.io/github/v/release/CheerChen/decotv-webos?include_prereleases&label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/webOS-TV-a50034?logo=lg&logoColor=white" alt="webOS" />
  <img src="https://img.shields.io/badge/root-not%20required-2ea44f" alt="No root" />
  <img src="https://img.shields.io/badge/DecoTV-server%20required-blue" alt="DecoTV server" />
  <img src="https://img.shields.io/badge/language-JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License" /></a>
</p>

---

## Screenshots

| Home | Category browse | Play history |
| :---: | :---: | :---: |
| ![Home](assets/screenshots/home.png) | ![Browse](assets/screenshots/search.png) | ![Library](assets/screenshots/library.png) |

| Detail · multi-source probe | Player · source switch | Settings |
| :---: | :---: | :---: |
| ![Detail](assets/screenshots/detail.png) | ![Player](assets/screenshots/player.png) | ![Settings](assets/screenshots/settings.png) |

---

## What this is

A **purpose-built webOS TV client** for [DecoTV](https://github.com/Decohererk/DecoTV) — not a browser wrapper.

- Talks to a self-hosted DecoTV server: Douban catalog, category filters, multi-source search, probe ranking, playback
- TV UI with remote D-pad focus navigation
- Native `<video>` **hardware HLS decode** on webOS (no HLS.js)
- **No root required** — Developer Mode or [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel)

The server ships empty: **no built-in media sources**. Configure sources on the DecoTV server.

Current version: [Releases](https://github.com/CheerChen/decotv-webos/releases).

---

## Features

| Feature | Notes |
| --- | --- |
| Home wall | Continue-watching on top; hot / latest movies & series rows |
| Category browse | Hot + curated tabs for movies, series, anime, variety, documentary; chip filters |
| Multi-source probe ranking | Concurrent source checks; rank by resolution → throughput → startup; auto-play best |
| Episode-first layout | Episode grid sits above the (often long) source list |
| Failover / manual switch | Auto next source on failure; in-player source side panel |
| Progress memory | Keyed by title + year (survives source switch); resume support |
| Local library | Favorites & play history on-device; clear history from Settings |
| Settings layout | Left: actions (change server, clear history); right: read-only client + server info |
| Remote UX | D-pad / OK / Back; geometry focus engine |
| Player OSD | Live resolution + buffer; episode / source side panels |
| Hardware decode | Platform HLS, no HLS.js |

### Differences from the PC web UI

| Topic | PC / browser DecoTV | This client |
| --- | --- | --- |
| Auth | Multiple modes | **`public` only** (see below) |
| Favorites / progress | Can sync via server | **TV-local `localStorage`**, no multi-device sync |
| Source config | Server admin | Same — not configured in-app |
| Decode | HLS.js / ArtPlayer, etc. | Platform hardware decode |

**Why `public` only:** the app loads from `file://`, so API calls are cross-site. A `SameSite=Lax` session cookie cannot be stored in the TV webview, and the app cannot read or set the `Cookie` header. The server must run in `public` mode so browse, search, and playback work without an account cookie.

```bash
NEXT_PUBLIC_AUTH_MODE=public
```

Non-public servers surface a notice on the app’s server configuration screen.

---

## Requirements

1. **LG webOS TV** (Developer Mode or Homebrew Channel; root optional)
2. **DecoTV server** with `AuthMode = public`
3. Network reachability from the TV to the server

Server setup: [DecoTV](https://github.com/Decohererk/DecoTV)

---

## Install

### A — Homebrew Channel (planned)

After listing in [webosbrew/apps-repo](https://github.com/webosbrew/apps-repo), install from Homebrew Channel on the TV.

### B — Developer Mode / sideload

Download a prebuilt IPK from [Releases](https://github.com/CheerChen/decotv-webos/releases).

**Developer Mode:** install with LG’s `ares-install`.

**Rooted TV (opkg path, bypasses appinstalld extraction failures):**

Replace `TV` with the TV’s LAN IP or an SSH host alias from `~/.ssh/config`.

```bash
scp com.cheerchen.decotv_*_all.ipk root@TV:/tmp/decotv.ipk
ssh root@TV 'opkg --add-dest developer:/media/developer install -d developer /tmp/decotv.ipk && \
          mkdir -p /media/developer/apps/usr/palm/applications/ && \
          cp -a /media/developer/usr/palm/applications/com.cheerchen.decotv \
                /media/developer/apps/usr/palm/applications/'
ssh root@TV 'sync; reboot'   # first install needs reboot for sam registration
```

Or package locally:

```bash
# -n is required: native ES modules break the bundled minifier
ares-package . -n
# → com.cheerchen.decotv_<version>_all.ipk
```

---

## Quick start

1. Install and open **DecoTV**
2. Enter the server URL, e.g. `http://192.168.1.10:3000`
3. Browse the home wall with the D-pad; OK opens detail
4. Detail probes sources and starts the best one; switch sources on failure or via the panel
5. Favorites and play history live under Library; client and server info are read-only on the right of Settings

---

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | webOS Web App (WAM / Chromium) |
| Language | Native ES modules, no bundler |
| UI | Focus engine + screen router |
| Playback | Native `<video>` + UMS hardware decode |
| API | DecoTV / LunaTV-compatible HTTP |
| Local data | `localStorage` (favorites, play history, server URL) |
| Package | `ares-package` → IPK |

---

## Development

```bash
npm test

# Hot-update (rooted / already installed): push sources + CDP reload, no repackage
# Replace TV with LAN IP or SSH host alias
scp -r js css index.html root@TV:/media/developer/apps/usr/palm/applications/com.cheerchen.decotv/
# CDP tunnel example: ssh -f -N -L 9977:localhost:9998 root@TV
uv run scripts/cdp_reload.py
```

App ID: `com.cheerchen.decotv`.

Helpers: `scripts/cdp_eval.py`, `scripts/cdp_reload.py`, `scripts/cdp_screenshot.py`.

---

## Related

- [DecoTV](https://github.com/Decohererk/DecoTV) — server / web UI
- [webosbrew](https://github.com/webosbrew) — community tools and app catalog
- [youtube-webos](https://github.com/webosbrew/youtube-webos)
- [jellyfin-webos](https://github.com/jellyfin/jellyfin-webos)

---

## Disclaimer

- Client shell only — **no bundled media sources**
- Operators must deploy DecoTV and configure sources lawfully
- Do not promote this project bundled with piracy sources

---

## License

[MIT](LICENSE). Upstream DecoTV and third-party dependencies keep their own licenses.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=CheerChen/decotv-webos&type=Date)](https://star-history.com/#CheerChen/decotv-webos&Date)
