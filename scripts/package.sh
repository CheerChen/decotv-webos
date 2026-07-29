#!/usr/bin/env bash
# Build the release IPK from a clean staging directory, gate the payload, and
# sync the Homebrew Channel manifest.
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
#
# Two gates guard the result, because both have already failed once:
#   1. The staged tree must match scripts/ipk-contents.txt exactly, and the IPK
#      must stay under MAX_IPK_KB. Adding a file is fine — run with
#      --update-contents to re-record the list, so the growth is a reviewable
#      diff instead of a silent 13 MB regression.
#   2. The manifest's version / ipkUrl / sha256 must describe the artifact that
#      was actually published. 0.4.1 shipped a manifest hash matching no
#      released IPK (fixed in ecc01d4) because they were hand-synced.
#
# ares-package is NOT reproducible — packaging identical inputs twice yields
# different sha256 sums. So the manifest can only ever describe one specific
# build, and --release must be the LAST build before uploading: whatever file
# that run produces is the file that has to reach the GitHub release. A plain
# build therefore never touches the manifest; use --verify-release after
# publishing to prove the manifest and the uploaded asset agree.
#
# Usage:
#   scripts/package.sh                    build + payload/size gates
#   scripts/package.sh --update-contents  re-record the expected file list
#   scripts/package.sh --release          build + point the manifest at it
#   scripts/package.sh --verify-release   hash the published asset vs manifest
set -euo pipefail

APP_ID="com.cheerchen.decotv"
MAX_IPK_KB=2048
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTENTS="$ROOT/scripts/ipk-contents.txt"
MANIFEST="$ROOT/${APP_ID}.manifest.json"
SERVICE="$ROOT/service/${APP_ID}.service"
STAGE="$(mktemp -d)/${APP_ID}"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

UPDATE_CONTENTS=""
RELEASE=""
for arg in "$@"; do
  case "$arg" in
    --update-contents) UPDATE_CONTENTS=1 ;;
    --release) RELEASE=1 ;;
    --verify-release) VERIFY_RELEASE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# --verify-release does not build: it re-hashes the artifact GitHub is actually
# serving and compares it against the manifest the Homebrew Channel reads.
if [ -n "${VERIFY_RELEASE:-}" ]; then
  M_VER="$(node -p "require('$MANIFEST').version")"
  M_URL="$(node -p "require('$MANIFEST').ipkUrl")"
  M_SHA="$(node -p "require('$MANIFEST').ipkHash.sha256")"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "manifest: v${M_VER} ${M_URL}"
  GH_TOKEN="$(gh auth token --user CheerChen)" gh release download "v${M_VER}" \
    --repo CheerChen/decotv-webos --pattern "$M_URL" --dir "$TMP"
  GOT="$(shasum -a 256 "$TMP/$M_URL" | awk '{print $1}')"
  if [ "$GOT" != "$M_SHA" ]; then
    echo "FAIL: published asset sha256 $GOT != manifest $M_SHA" >&2
    exit 1
  fi
  echo "OK: published asset matches manifest ($GOT)"
  exit 0
fi

mkdir -p "$STAGE/assets"
cd "$ROOT"
cp appinfo.json index.html LICENSE "$STAGE/"
cp -R js css webOSTVjs-1.2.12 "$STAGE/"
cp -R assets/icons "$STAGE/assets/"
cp assets/splash.png "$STAGE/assets/"
find "$STAGE" -name ".DS_Store" -delete

# ── Gate 1a: staged tree matches the recorded payload ──────────────────────
ACTUAL="$(
  {
    cd "$STAGE"
    find . -type f | sed 's|^\./||'
    cd "$ROOT"
    find "service/${APP_ID}.service" -type f
  } | LC_ALL=C sort
)"
if [ -n "$UPDATE_CONTENTS" ]; then
  printf '%s\n' "$ACTUAL" > "$CONTENTS"
  echo "recorded $(wc -l < "$CONTENTS" | tr -d ' ') files -> scripts/ipk-contents.txt"
elif [ ! -f "$CONTENTS" ]; then
  echo "FAIL: $CONTENTS missing — run: scripts/package.sh --update-contents" >&2
  exit 1
else
  if ! diff -u "$CONTENTS" <(printf '%s\n' "$ACTUAL") > /tmp/ipk-contents.diff; then
    echo "FAIL: IPK payload differs from scripts/ipk-contents.txt" >&2
    echo "      (-expected +actual; intentional? re-run with --update-contents)" >&2
    sed -n '3,$p' /tmp/ipk-contents.diff >&2
    exit 1
  fi
  echo "OK: payload matches ipk-contents.txt ($(wc -l < "$CONTENTS" | tr -d ' ') files)"
fi

# -n skips minification: the sources are plain unminified ES modules and the
# bundled minifier breaks them.
ares-package "$STAGE" "$SERVICE" -n -o "$ROOT" > /dev/null

VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' appinfo.json | head -1)"
IPK="$ROOT/${APP_ID}_${VERSION}_all.ipk"
[ -f "$IPK" ] || { echo "FAIL: expected artifact not found: $IPK" >&2; exit 1; }

# ── Gate 1b: size ceiling ──────────────────────────────────────────────────
SIZE_KB=$(( ( $(wc -c < "$IPK") + 1023 ) / 1024 ))
if [ "$SIZE_KB" -gt "$MAX_IPK_KB" ]; then
  echo "FAIL: IPK is ${SIZE_KB} KB, over the ${MAX_IPK_KB} KB ceiling" >&2
  exit 1
fi

SHA="$(shasum -a 256 "$IPK" | awk '{print $1}')"

# ── Gate 2: manifest describes the artifact being published (--release only) ─
if [ -n "$RELEASE" ]; then
  node - "$MANIFEST" "$VERSION" "${APP_ID}_${VERSION}_all.ipk" "$SHA" <<'NODE'
const fs = require('fs');
const [file, version, ipkUrl, sha256] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
m.version = version;
m.ipkUrl = ipkUrl;
m.ipkHash = { sha256 };
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
console.log('manifest -> v' + version + ' ' + sha256);
NODE
fi

printf '\n%s\n' "$IPK"
printf 'size:   %s KB (ceiling %s KB)\n' "$SIZE_KB" "$MAX_IPK_KB"
printf 'sha256: %s\n' "$SHA"
if [ -n "$RELEASE" ]; then
  printf '\nUpload THIS file — rebuilding changes the hash and invalidates the manifest.\n'
  printf 'After publishing: scripts/package.sh --verify-release\n'
fi
