#!/usr/bin/env bash
# Starts the App Service zip from a clean folder, as App Service would (`npm start`, PORT,
# no repository around it), against a new database, and checks it: migrations applied at
# start, /health, the web app and its caching, the API.
#   DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres \
#   scripts/smoke-appservice.sh out/wansurvey-appservice.zip
set -euo pipefail
ZIP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
SERVER=${DATABASE_ADMIN_URL:?the admin URL of a Postgres server}
DB=wansurvey_smoke_$$
DIR=$(mktemp -d)
PORT=${PORT:-38080}
if curl -s "http://localhost:$PORT/health" >/dev/null; then
  echo "Something already answers on port $PORT" >&2
  exit 1
fi
LOG="$DIR/app.log"
cleanup() {
  # The whole group: npm and the node it started.
  [[ -n "${PID:-}" ]] && kill -- -"$PID" 2>/dev/null || true
  psql "$SERVER" -qc "drop database if exists $DB" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

psql "$SERVER" -qc "create database $DB"
ADMIN_URL="${SERVER%/*}/$DB"
HOST=$(sed -E 's#^postgres(ql)?://[^@]*@##; s#/.*$##' <<<"$SERVER")
mkdir "$DIR/wwwroot" && (cd "$DIR/wwwroot" && unzip -q "$ZIP")

cd "$DIR/wwwroot"
# The native modules load from the package (built for this platform): passwords, scanned PDFs.
node --input-type=module -e "
  const { hash } = await import('@node-rs/argon2');
  const { createCanvas } = await import('@napi-rs/canvas');
  await hash('x'); createCanvas(10, 10).getContext('2d').fillRect(0, 0, 5, 5);
" || { echo "FAIL: native modules" >&2; exit 1; }
setsid env -i PATH="$PATH" HOME="$DIR" PORT="$PORT" NODE_ENV=production \
  DATABASE_ADMIN_URL="$ADMIN_URL" \
  DATABASE_URL="postgres://wansurvey_app:smoke-password@$HOST/$DB" \
  APP_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  PUBLIC_WEB_URL="http://localhost:$PORT" API_PUBLIC_URL="http://localhost:$PORT" \
  MAILER=console EXPORT_STORAGE=blob \
  AZURE_STORAGE_CONNECTION_STRING='UseDevelopmentStorage=true' \
  WEB_DIST="$DIR/wwwroot/public" TRUST_PROXY_HOPS=1 LOG_LEVEL=warn \
  npm start >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/health" >/dev/null && break
  kill -0 "$PID" 2>/dev/null || { cat "$LOG"; echo "The app stopped" >&2; exit 1; }
  sleep 1
done
fail() { echo "FAIL: $1" >&2; tail -30 "$LOG" >&2; exit 1; }
curl -sf "http://localhost:$PORT/health" >/dev/null || fail "/health"
n=$(psql "$ADMIN_URL" -tAc "select count(*) from drizzle.__drizzle_migrations")
[[ "$n" -gt 40 ]] || fail "migrations at start ($n applied)"
curl -sf "http://localhost:$PORT/" | grep -q '<div id="root"' || fail "the app shell at /"
curl -sf "http://localhost:$PORT/projects/x/cases" | grep -q '<div id="root"' || fail "a client route"
asset=$(curl -sf "http://localhost:$PORT/" | grep -oE '/assets/[^"]+\.js' | head -1)
curl -sfI "http://localhost:$PORT$asset" | grep -qi 'cache-control: public, max-age=31536000, immutable' ||
  fail "asset caching ($asset)"
[[ $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/v1/auth/me") == 401 ]] ||
  fail "the API"
echo "OK: the package starts, migrates, and serves the API and the web app"
