#!/usr/bin/env bash
# The zip App Service runs as it is (Linux, Node 24, no containers): the API built, its
# production dependencies as plain folders (no symlinks: a mounted package cannot hold them),
# the migrations, and the web app in public/, served by the API (WEB_DIST).
#   scripts/package-appservice.sh [out-dir]     → <out-dir>/wansurvey-appservice.zip
#   scripts/package-appservice.sh [out-dir] --dev   → <out-dir>/wansurvey-dev.zip: the same, plus a
#       launcher (start-dev.sh / start-dev.cmd) that starts a disposable SQL Server in Docker, the
#       database with the demo data and the app, for trying it out. Never deploy this one.
# Build it on Linux x64: native modules (Argon2, the canvas that draws scanned PDFs) are
# installed for the platform that builds them.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV=0
ARGS=()
for a in "$@"; do if [[ "$a" == "--dev" ]]; then DEV=1; else ARGS+=("$a"); fi; done
OUT=$(mkdir -p "${ARGS[0]:-$ROOT/out}" && cd "${ARGS[0]:-$ROOT/out}" && pwd)
NAME=wansurvey-appservice
[[ $DEV == 1 ]] && NAME=wansurvey-dev
STAGE="$OUT/$NAME"
cd "$ROOT"

if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
  echo "Build on Linux x64 (App Service's platform), not $(uname -s)-$(uname -m)" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm -r --filter "./packages/*" build
pnpm --filter @wansurvey/api build
pnpm --filter @wansurvey/web build

rm -rf "$STAGE" "$OUT/$NAME.zip"
pnpm --filter @wansurvey/api deploy --prod --legacy --config.node-linker=hoisted "$STAGE"
# Command links (the only symlinks); App Service starts the app with `npm start`.
find "$STAGE/node_modules" -type d -name .bin -prune -exec rm -rf {} +
# App Service's Node images are Debian (glibc): the musl build of the canvas is not used.
rm -rf "$STAGE"/node_modules/@napi-rs/canvas-linux-x64-musl
cp -r apps/web/dist "$STAGE/public"
if [[ $DEV == 1 ]]; then
  cp scripts/dev-launcher/dev-start.mjs scripts/dev-launcher/start-dev.sh scripts/dev-launcher/start-dev.cmd "$STAGE/"
  cp scripts/dev-launcher/README.md "$STAGE/README.md"
  chmod +x "$STAGE/start-dev.sh"
  for f in dist/db/dev-db.js dist/db/seed.js; do
    [[ -e "$STAGE/$f" ]] || { echo "Missing in the package: $f" >&2; exit 1; }
  done
fi

links=$(find "$STAGE" -type l | head -5)
if [[ -n "$links" ]]; then
  echo "Symbolic links left in the package:" >&2
  echo "$links" >&2
  exit 1
fi
for f in dist/main.js mssql/0000_init.sql public/index.html package.json; do
  [[ -e "$STAGE/$f" ]] || { echo "Missing in the package: $f" >&2; exit 1; }
done

(cd "$STAGE" && zip -qr "$OUT/$NAME.zip" .)
# The folder stays out of the repository's lint and format checks.
rm -rf "$STAGE"
echo "$OUT/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
