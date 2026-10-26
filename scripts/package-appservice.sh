#!/usr/bin/env bash
# The zip App Service runs as it is (Linux, Node 24, no containers): the API built, its
# production dependencies as plain folders (no symlinks: a mounted package cannot hold them),
# the migrations, and the web app in public/, served by the API (WEB_DIST).
#   scripts/package-appservice.sh [out-dir]     → <out-dir>/wansurvey-appservice.zip
# Build it on Linux x64: native modules (Argon2, the canvas that draws scanned PDFs) are
# installed for the platform that builds them.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/out}" && cd "${1:-$ROOT/out}" && pwd)
STAGE="$OUT/wansurvey-appservice"
cd "$ROOT"

if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
  echo "Build on Linux x64 (App Service's platform), not $(uname -s)-$(uname -m)" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm -r --filter "./packages/*" build
pnpm --filter @wansurvey/api build
pnpm --filter @wansurvey/web build

rm -rf "$STAGE" "$OUT/wansurvey-appservice.zip"
pnpm --filter @wansurvey/api deploy --prod --legacy --config.node-linker=hoisted "$STAGE"
# Command links (the only symlinks); App Service starts the app with `npm start`.
find "$STAGE/node_modules" -type d -name .bin -prune -exec rm -rf {} +
# App Service's Node images are Debian (glibc): the musl build of the canvas is not used.
rm -rf "$STAGE"/node_modules/@napi-rs/canvas-linux-x64-musl
cp -r apps/web/dist "$STAGE/public"

links=$(find "$STAGE" -type l | head -5)
if [[ -n "$links" ]]; then
  echo "Symbolic links left in the package:" >&2
  echo "$links" >&2
  exit 1
fi
for f in dist/main.js drizzle/meta/_journal.json public/index.html package.json; do
  [[ -e "$STAGE/$f" ]] || { echo "Missing in the package: $f" >&2; exit 1; }
done

(cd "$STAGE" && zip -qr "$OUT/wansurvey-appservice.zip" .)
echo "$OUT/wansurvey-appservice.zip ($(du -h "$OUT/wansurvey-appservice.zip" | cut -f1))"
