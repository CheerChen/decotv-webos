#!/usr/bin/env bash
# Build the release IPK from a clean staging directory.
#
# Running `ares-package .` on the repo root packages everything it finds —
# .git, docs/, tests/, scripts/, the README screenshots — which is how 0.4.0
# shipped a 13 MB IPK for a 400 KB app. ares-package's --app-exclude is not a
# way out either: it splices the patterns straight into a regex, so any
# pattern containing ** throws "Invalid regular expression: Nothing to repeat".
#
# Staging the shipped files explicitly is both smaller and unambiguous about
# what reaches the TV. Keep this list in sync with the runtime references in
# index.html (css/, js/, webOSTVjs-*/) and appinfo.json (icons, splash).
set -euo pipefail

APP_ID="com.cheerchen.decotv"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)/${APP_ID}"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

mkdir -p "$STAGE/assets"
cd "$ROOT"
cp appinfo.json index.html LICENSE "$STAGE/"
cp -R js css webOSTVjs-1.2.12 "$STAGE/"
cp -R assets/icons "$STAGE/assets/"
cp assets/splash.png "$STAGE/assets/"
find "$STAGE" -name ".DS_Store" -delete

# -n skips minification: the sources are plain unminified ES modules and the
# bundled minifier breaks them.
ares-package "$STAGE" -n -o "$ROOT"

VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' appinfo.json | head -1)"
IPK="$ROOT/${APP_ID}_${VERSION}_all.ipk"
printf '\n%s\n' "$IPK"
ls -lh "$IPK" | awk '{print "size:   " $5}'
shasum -a 256 "$IPK" | awk '{print "sha256: " $1}'
