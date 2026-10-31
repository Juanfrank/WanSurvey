#!/usr/bin/env bash
# Starts the API twice, on PostgreSQL and on SQL Server over the copied data, and compares the
# answers of the read endpoints as the same person (scripts/compare-engines.mjs).
#   PG_APP_URL   postgres://wansurvey_app:…@host/db   the source database, as the application user
#   MS_APP_URL   mssql://wansurvey_app:…@host/db      the copy, as the application user
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PG_APP_URL:?}" "${MS_APP_URL:?}"
export NODE_ENV=development APP_ENCRYPTION_KEY="${APP_ENCRYPTION_KEY:-MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=}" \
  PUBLIC_WEB_URL=http://localhost:4173 LOGIN_RATE_LIMIT=100000 RATE_LIMIT_PER_IP=1000000 \
  LOG_LEVEL=warn MAILER=file MAIL_OUTBOX_DIR="${TMPDIR:-/tmp}/mail-parity" GEOCODER=none
mkdir -p "$MAIL_OUTBOX_DIR"
PORT=3101 DATABASE_URL="$PG_APP_URL" node dist/main.js > "${TMPDIR:-/tmp}/api-pg.log" 2>&1 &
pg=$!
PORT=3100 DB_ENGINE=mssql DATABASE_URL="$MS_APP_URL" node dist/main.js > "${TMPDIR:-/tmp}/api-ms.log" 2>&1 &
ms=$!
trap 'kill $pg $ms 2>/dev/null || true' EXIT
for url in http://localhost:3101 http://localhost:3100; do
  for _ in $(seq 1 60); do curl -sf "$url/health" >/dev/null && break; sleep 2; done
  curl -sf "$url/health" >/dev/null || { echo "No answer from $url"; tail -20 "${TMPDIR:-/tmp}"/api-*.log; exit 1; }
done
node scripts/compare-engines.mjs http://localhost:3101 http://localhost:3100
