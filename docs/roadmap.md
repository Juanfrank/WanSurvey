# Roadmap

Planned work that is not built yet. Each item says why, what it takes and in what order.

## SQL Server replaces PostgreSQL (SQLite for test instances, for a while)

**Status:** planned. Today the app runs on PostgreSQL only (`docs/azure.md`, "Moving to SQL
Server later", lists every PostgreSQL feature in use).

**Why:** the organisation's databases are on SQL Server (Azure SQL); a second database engine is a
service to approve and run.

**Decisions:**

- **SQL Server is the one database.** PostgreSQL is deprecated: no new work targets it, and it is
  removed once SQL Server runs in production. The app never keeps three dialects alive.
- **SQLite only for test instances, in this first implementation.** A file, no server: for trial
  deployments and demos while SQL Server is brought up. It is never production, never holds real
  data, and is deprecated in turn once SQL Server instances are available for testing.
- At any moment at most two engines exist in the code: PostgreSQL (until the switch) with SQL
  Server, or SQL Server with SQLite (until SQLite is retired).

### Approach

1. **A data layer with dialects.** Replace Drizzle (no stable SQL Server driver) with Kysely, which
   has SQL Server (`tedious`) and SQLite (`better-sqlite3`) dialects, behind the services as they
   are. What differs per engine (JSON, locks, time zones) goes through a small set of helpers.
2. **Isolation by organisation on SQL Server:** security policies with a predicate on
   `SESSION_CONTEXT(N'tenant_id')`, set per transaction as `app.tenant_id` is today;
   `EXECUTE AS OWNER` procedures in place of the security-definer functions (sign-in, respondent
   links, nightly jobs, erasure). SQLite has no row-level security: there the data layer adds the
   organisation filter itself, which is acceptable only because SQLite never holds real data.
3. **Migrations in T-SQL**, the history triggers (append-only answers) as `INSTEAD OF UPDATE,
DELETE`. SQLite gets the schema it needs for test instances, without those guarantees.
4. **The analysis model (`bi`)** and the SQL export (`sql-export.ts`) in T-SQL; on SQLite, tables
   filled by the refresh job.

### What SQLite lacks, and its stand-in (test instances only)

| SQL Server / PostgreSQL             | SQLite                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Row-level security                  | Organisation filter in the data layer                      |
| Owner procedures / security definer | The same logic in the app                                  |
| Row locks (`UPDLOCK`, `FOR UPDATE`) | One writer at a time (SQLite locks the file): no row locks |
| JSON functions                      | JSON1 functions (`json_extract`, `json_each`)              |
| Application locks (migrations)      | A lock row in a table                                      |
| Time zones in SQL                   | Days computed in JS                                        |
| Views and refresh of the `bi` model | Tables filled by the refresh job                           |

### Phases

1. **Data layer on SQL Server**, PostgreSQL still serving production: the SQL Server dialect,
   T-SQL migrations, security policies and procedures. The whole test suite, the isolation tests
   first, on SQL Server in CI (container `mcr.microsoft.com/mssql/server`).
2. **SQLite for test instances**: the same data layer on a file, for trial deployments while SQL
   Server environments are prepared. Its tests cover what test instances use; security and
   concurrency are only ever proven on SQL Server.
3. **Analysis model and SQL export** in T-SQL.
4. **Load measurements on Azure SQL** (the runs in `load/results.md`), then **the switch**: data
   moved from PostgreSQL, production on SQL Server.
5. **Removals**: PostgreSQL (migrations, dialect, CI) right after the switch; SQLite once SQL
   Server test instances replace it. One engine remains: SQL Server.

### Risks

- **SQLite does not behave like production**: no concurrency, no row locks, no row-level
  security. It must never be mistaken for a check of security or concurrency.
- **Moving the data**: a one-time copy from PostgreSQL to SQL Server, with the history and
  encrypted fields as they are, checked by counts and samples before the switch.
- **The size of the change**: every migration (45 today) and the data access of every service.

## Microsoft sign-in settings: `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_REDIRECT_URI`

**Status:** pending.

The deployment's Microsoft sign-in is set by these four settings:

| Setting               | Today                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `ENTRA_TENANT_ID`     | Exists with this name                                                |
| `ENTRA_CLIENT_ID`     | Exists with this name                                                |
| `ENTRA_CLIENT_SECRET` | Exists with this name                                                |
| `ENTRA_REDIRECT_URI`  | New: today built from `PUBLIC_WEB_URL` + `/api/v1/auth/sso/callback` |

What it takes:

- `ENTRA_REDIRECT_URI` in the configuration, used for the authorize request and the code exchange
  (`apps/api/src/auth/sso.service.ts`), and shown by `GET /api/v1/tenant/sso`. It is the same
  value registered in Entra, so the two are compared at a glance.
- Checked at start: an absolute `https` address (`http` only for `localhost`) ending in
  `/api/v1/auth/sso/callback`, required together with the other three.
- The templates in `appconfig/`, `apps/api/.env.example`, `infra/azure/main.bicep`,
  `docs/sso-entra.md` and `docs/appservice-zip.md` updated; tests for the value and its checks.
