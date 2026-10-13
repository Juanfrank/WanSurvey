#!/usr/bin/env bash
# Runs the API tests the way Azure Database for PostgreSQL (or any managed Postgres) would:
# the database owner is an ordinary role with CREATEROLE, not a superuser.
# Usage: PGSUPER=postgres://postgres:postgres@localhost:5432/postgres apps/api/scripts/azure-like-db.sh
set -euo pipefail
super="${PGSUPER:-postgres://postgres:postgres@localhost:5432/postgres}"
host="${super#*@}"; host="${host%%/*}"
psql "$super" -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS wansurvey_azure WITH (FORCE);
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'azure_admin') THEN
    CREATE ROLE azure_admin LOGIN PASSWORD 'azure_admin' CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- On Azure the admin creates the application role and so administers it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wansurvey_app') THEN
    CREATE ROLE wansurvey_app LOGIN PASSWORD 'wansurvey_app';
  END IF;
END \$\$;
GRANT wansurvey_app TO azure_admin WITH ADMIN OPTION;
CREATE DATABASE wansurvey_azure OWNER azure_admin;
SQL
psql "${super%/*}/wansurvey_azure" -v ON_ERROR_STOP=1 -c 'ALTER SCHEMA public OWNER TO azure_admin'
cd "$(dirname "$0")/.."
TEST_DATABASE_ADMIN_URL="postgres://azure_admin:azure_admin@${host}/wansurvey_azure" \
TEST_DATABASE_URL="postgres://wansurvey_app:wansurvey_app@${host}/wansurvey_azure" \
  pnpm exec vitest run
