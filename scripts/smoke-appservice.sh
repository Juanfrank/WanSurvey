#!/usr/bin/env bash
# Starts the App Service zip from a clean folder, as App Service would (`npm start`, PORT,
# no repository around it), against a new database, and checks it: migrations applied at
# start, /health, the web app and its caching, the API.
#   DATABASE_ADMIN_URL='mssql://sa:Wansurvey_Test1%21@localhost:1433/master?trustServerCertificate=true' \
#   scripts/smoke-appservice.sh out/wansurvey-appservice.zip
set -euo pipefail
ZIP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
SERVER=${DATABASE_ADMIN_URL:?the admin URL (database master) of a SQL Server}
DB=wansurvey_smoke_$$
DIR=$(mktemp -d)
PORT=${PORT:-38080}
if curl -s "http://localhost:$PORT/health" >/dev/null; then
  echo "Something already answers on port $PORT" >&2
  exit 1
fi
LOG="$DIR/app.log"
# Runs one statement on the server through the package's own SQL Server client.
#   mssql <url> <statement>   prints the first column of the first row, if any
mssql() {
  (cd "$DIR/wwwroot" && node --input-type=module -e "
    const { createMssqlDb } = await import('./dist/db/mssql/connection.js');
    const { sql } = await import('kysely');
    const db = createMssqlDb(process.argv[1], { max: 1 });
    try {
      const r = await sql.raw(process.argv[2]).execute(db);
      if (r.rows[0]) console.log(Object.values(r.rows[0])[0]);
    } finally { await db.destroy(); }
  " "$1" "$2")
}
cleanup() {
  # The whole group: npm and the node it started.
  [[ -n "${PID:-}" ]] && kill -- -"$PID" 2>/dev/null || true
  [[ -d "$DIR/wwwroot" ]] && mssql "$SERVER" "ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE IF EXISTS [$DB]" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

mkdir "$DIR/wwwroot" && (cd "$DIR/wwwroot" && unzip -q "$ZIP")
mssql "$SERVER" "CREATE DATABASE [$DB]"
# The same server and credentials, the new database (the URL's path is the database).
ADMIN_URL=$(node -e "const u=new URL(process.argv[1]); u.pathname='/'+process.argv[2]; console.log(u.toString())" "$SERVER" "$DB")
APP_URL=$(node -e "const u=new URL(process.argv[1]); u.username='wansurvey_app'; u.password='Smoke-Passw0rd!'; u.pathname='/'+process.argv[2]; console.log(u.toString())" "$SERVER" "$DB")

cd "$DIR/wwwroot"
# The native modules load from the package (built for this platform): passwords, scanned PDFs.
node --input-type=module -e "
  const { hash } = await import('@node-rs/argon2');
  const { createCanvas } = await import('@napi-rs/canvas');
  await hash('x'); createCanvas(10, 10).getContext('2d').fillRect(0, 0, 5, 5);
" || { echo "FAIL: native modules" >&2; exit 1; }
setsid env -i PATH="$PATH" HOME="$DIR" PORT="$PORT" NODE_ENV=production \
  DATABASE_ADMIN_URL="$ADMIN_URL" \
  DATABASE_URL="$APP_URL" \
  APP_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  PUBLIC_WEB_URL="http://localhost:$PORT" \
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
n=$(mssql "$ADMIN_URL" "SELECT COUNT(*) FROM dbo.__migrations")
[[ "$n" -gt 40 ]] || fail "migrations at start ($n applied)"
curl -sf "http://localhost:$PORT/" | grep -q '<div id="root"' || fail "the app shell at /"
curl -sf "http://localhost:$PORT/projects/x/cases" | grep -q '<div id="root"' || fail "a client route"
asset=$(curl -sf "http://localhost:$PORT/" | grep -oE '/assets/[^"]+\.js' | head -1)
curl -sfI "http://localhost:$PORT$asset" | grep -qi 'cache-control: public, max-age=31536000, immutable' ||
  fail "asset caching ($asset)"
[[ $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/v1/auth/me") == 401 ]] ||
  fail "the API"
echo "OK: the package starts, migrates, and serves the API and the web app"
