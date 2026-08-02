#!/usr/bin/env bash
# Thin wrapper over the shared IPK build (tvkit/scripts/package-common.sh):
# staging, payload/size gates, ares-package -n with the bundled JS service,
# and Homebrew Channel manifest sync. See the shared script's header for the
# full rationale (non-reproducible ares-package, --release must be the last
# build before uploading, --verify-release afterwards).
#
# Usage:
#   scripts/package.sh                    build + payload/size gates
#   scripts/package.sh --update-contents  re-record scripts/ipk-contents.txt
#   scripts/package.sh --release          build + point the manifest at it
#   scripts/package.sh --verify-release   hash the published asset vs manifest
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec "$ROOT/tvkit/scripts/package-common.sh" \
  --app-id com.cheerchen.decotv \
  --root "$ROOT" \
  --max-kb 2048 \
  --contents scripts/ipk-contents.txt \
  --service service/com.cheerchen.decotv.service \
  --manifest com.cheerchen.decotv.manifest.json \
  --gh-repo CheerChen/decotv-webos \
  --gh-user CheerChen \
  "$@" \
  -- appinfo.json index.html LICENSE js css webOSTVjs-1.2.12 \
     assets/icons assets/splash.png
