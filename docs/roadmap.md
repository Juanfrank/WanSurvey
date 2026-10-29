# Roadmap

Planned work that is not built yet. Each item says why, what it takes and in what order.

## SQL Server in production, SQLite for development

**Status:** planned. Today the app runs on PostgreSQL only (`docs/azure.md`, "Moving to SQL
Server later", lists every PostgreSQL feature in use).

**Why:** the organisation's databases are on SQL Server (Azure SQL); a second database engine is
a service to approve and run. For development, a SQLite file needs no server at all.

**Goal:**

- Production on Azure SQL Database / SQL Server, with the same guarantees as today: each
  organisation sees only its own rows, enforced by the database.
- Development and fast tests on a SQLite file: `pnpm dev` with no database to install.

### Approach

1. **A data layer with dialects.** Replace Drizzle (no stable SQL Server driver) with Kysely, which
   has PostgreSQL, SQL Server (`tedious`) and SQLite (`better-sqlite3`) dialects, behind the
   services as they are. Queries specific to one engine (JSON, arrays, locks, time zones) go
   through a small set of helpers per dialect.
2. **Isolation by organisation:**
   - SQL Server: security policies with a predicate on `SESSION_CONTEXT(N'tenant_id')`, set per
     transaction as `app.tenant_id` is today; `EXECUTE AS OWNER` procedures replace the
     security-definer functions (sign-in, respondent links, nightly jobs, erasure).
   - SQLite has no row-level security: the data layer adds the organisation filter itself. That is
     for development only; it is never the security boundary.
3. **Migrations per dialect**, from one description where possible; the history triggers
   (append-only answers) in T-SQL `INSTEAD OF UPDATE, DELETE`.
4. **The analysis model (`bi`)**: today views and refresh functions in PostgreSQL SQL. On SQL Server
   in T-SQL; on SQLite as tables filled by the refresh job. The SQL export (`sql-export.ts`) writes
   T-SQL for SQL Server.

### What SQLite lacks, and its stand-in (development only)

| PostgreSQL                          | SQLite (development)                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| Row-level security                  | Organisation filter in the data layer                      |
| Security-definer functions          | The same logic in the app                                  |
| `FOR UPDATE`, `SKIP LOCKED`         | One writer at a time (SQLite locks the file): no row locks |
| `jsonb` and its operators           | JSON1 functions (`json_extract`, `json_each`)              |
| `text[]` and `= any(...)`           | JSON arrays                                                |
| `pg_advisory_lock` (migrations)     | A lock row in a table                                      |
| `AT TIME ZONE '<IANA>'`             | Days computed in JS                                        |
| Views and refresh of the `bi` model | Tables filled by the refresh job                           |

### Phases

1. **Data layer with dialects, PostgreSQL only.** Same behaviour; every test green, load
   measurements unchanged.
2. **SQLite for development.** `pnpm dev` and the fast test suites on a file; the isolation tests
   stay on a real engine.
3. **SQL Server.** Dialect, migrations, security policies and procedures; the whole test suite,
   the isolation tests first, on SQL Server in CI (container `mcr.microsoft.com/mssql/server`).
4. **Analysis model and SQL export** in T-SQL.
5. **Load measurements** on Azure SQL (the runs in `load/results.md`), then the switch.

### Risks

- **SQLite does not behave like the production database**: no concurrency, no row locks, no
  row-level security. It speeds up development; it cannot validate security or concurrency, so
  those tests always run on SQL Server (and PostgreSQL while it is kept).
- **Three dialects to keep** while PostgreSQL remains; once SQL Server is in production,
  PostgreSQL can be dropped.
- **The size of the change**: every migration (45 today) and the data access of every service.
