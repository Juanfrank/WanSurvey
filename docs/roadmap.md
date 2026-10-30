# Roadmap

Planned work that is not built yet. Each item says why, what it takes and in what order.

## SQL Server replaces PostgreSQL (SQLite for test instances, for a while)

**Status:** phase 1 well advanced (every vertical but the analysis model). Done and tested in CI (job `sqlserver`, on a SQL Server 2022
container): the data layer with Kysely and tedious (`apps/api/src/db/mssql/`), the T-SQL
migrations for organisations, users, projects, memberships, sessions, tokens and the audit log
(`apps/api/mssql/`), the contained application user, and the isolation by security policy with
its tests (`apps/api/test/mssql/`). Everything else still runs on PostgreSQL with Drizzle; the
rest of the migrations and the services move vertical by vertical.

Verticals done on SQL Server (data layer and tests; the controllers still serve from PostgreSQL
until the switch):

- **Isolation kernel**: organisations, users, projects, memberships, sessions, tokens, audit log.
- **Questionnaires** (`mssql/0002`, `src/questionnaires/questionnaire-store.mssql.ts`): drafts
  saved by compare-and-swap, publishing under a row lock, versions immutable by trigger,
  scenarios, review comments, presence, the library, and state (disable, complete, successor).

- **Cases and sampling** (`mssql/0003`, `0004`; `src/cases/cases-store.mssql.ts`,
  `src/sampling/sampling-store.mssql.ts`): sample fields, cases with contacts and an append-only
  history, imports, assignment rules, the sampling plan and frame, cases made from selected units,
  reserves and interviewer goals. Bulk loads go through one JSON parameter and `OPENJSON`; claiming
  a free case uses `READPAST` over a filtered index. **Left for the interviews vertical:** the
  expiry of overdue cases, which checks for an open interview in a table not moved yet.

- **Interviews and CATI** (`mssql/0005`; `src/interviews/interviews-store.mssql.ts`,
  `src/cati/cati-store.mssql.ts`): interviews with their snapshot, device acknowledgements, the
  append-only answer and paradata history, and call attempts. A change number sent twice is
  dropped by the database (`IGNORE_DUP_KEY` unique indexes); the snapshot is written under a row
  lock; the call queue keeps the PostgreSQL order and conditions; one caller has one open call
  (an application lock owned by the transaction). The **expiry of overdue cases**, left out of the
  cases vertical, is done here.

- **Review** (`mssql/0006`; `src/review/review-store.mssql.ts`): statuses, flags, comments,
  corrections and coding, with the same counted statuses as PostgreSQL.

- **Web surveys, e-mail and feedback** (`mssql/0007`; `src/cawi/cawi-store.mssql.ts`):
  templates, waves, invitations (once per case in a wave) with delivery tracking and dispatcher
  leases, suppressed addresses, open links, feedback points and responses. The lookups that run
  before any organisation is known (token, slug, link hash) are owner procedures, and
  `MssqlDatabase.withTenantOf` finds the organisation from them and works in it.

- **Paper, statistics and exports** (`mssql/0008`; `src/papi/`, `src/stats/`, `src/exports/`
  `*.mssql.ts`): double-entry differences, scanned batches with forms and page images, daily
  figures, export jobs and summary links. Batches and export jobs are taken once with a shared
  claim (`src/jobs/claim.mssql.ts`); daily figures are bucketed by the project's local day.

**Left:** the analysis model (`bi`) and the SQL export, then the switch of the controllers.

More from the real SQL Server: `AT TIME ZONE` takes Windows zone names, not IANA, so the local
day's bounds are worked out in JS (`src/stats/zoned-day.ts`); GUIDs come back in uppercase, so
compare them lowercased; `datetimeoffset(3)` keeps milliseconds only, so a test that compares
times round-trips whole seconds; two cascading paths to one table are refused, so the store
deletes children in order; `file` and `plan` are reserved words (bracket them); an append-only
event table's single unique index can be `IGNORE_DUP_KEY`; a key that must be unique only when
present needs a filtered unique index; keyset paging on `(submitted_at, id)` is written as an OR
because there are no row constructors.

What the tests on a real SQL Server taught, for the verticals to come: an error thrown by a
trigger or a deadlock ends the transaction and hides the error behind a failed rollback (the data
layer now reports the first error, and the deadlock retry works); a password may not contain the
user's name; `plan` is a reserved word; `THROW` in an `INSTEAD OF` trigger is the way to refuse a
change; a unique index fails with 2601 and a unique constraint with 2627; `UPDLOCK` locks every
row an unordered scan reads, so a "take the next row" query needs an index in its order for
`READPAST` to work; `ISNULL(@parameter, 'literal')` takes the parameter's type and may cut the
literal, so cast the parameters to the column's type; there is no `ON CONFLICT DO NOTHING`
(use `NOT EXISTS` under `UPDLOCK, HOLDLOCK`, or `IGNORE_DUP_KEY` on an append-only table's
only unique index) and statements are limited to 2100 parameters; `ISJSON` refuses plain scalars
(`5`, `"text"`), so a column that holds any JSON value is not checked with it; an index key is
limited to 900 bytes (1700 if not clustered), so ids that are text stay short; a unique index on
a nullable column that must allow many NULLs needs a filter (`WHERE col IS NOT NULL`). Today the app runs on PostgreSQL only (`docs/azure.md`, "Moving to SQL
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
