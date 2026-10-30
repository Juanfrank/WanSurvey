# Roadmap

Planned work that is not built yet. Each item says why, what it takes and in what order.

## SQL Server replaces PostgreSQL (SQLite for test instances, for a while)

**Status:** phase 1 well advanced (every vertical, with the analysis model). Done and tested in CI (job `sqlserver`, on a SQL Server 2022
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

- **Analysis model and SQL export** (`mssql/0009`; `src/stats/bi-store.mssql.ts`,
  `src/exports/sql-export.mssql.ts`): SQL Server has no materialised views, so the dimension and
  fact tables of schema `bi` are tables that owner procedures empty and fill again
  (`bi.refrescar_vista`, one table per transaction, under an application lock; `bi.refrescar`
  for all). The application can run the procedures and read nothing in `bi`. Local days use the
  UTC offsets of the projects' IANA zones, which the application works out (`zoneOffsets`) and
  saves in `bi.zona`. The T-SQL export gives the same sheets and cells as the Excel one.
  Each person carries their teams (`mssql/0010`, `src/teams/teams-store.mssql.ts`).

- **Identity and the audit log** (`mssql/0011`; `src/audit/audit-store.mssql.ts`): `0000` and `0001`
  had followed the schema from before multi-organisation accounts, so `0011` brings it to parity
  with PostgreSQL: accounts are global and an organisation sees a person through its
  `tenant_members` row; a person changes only their own account (`SESSION_CONTEXT 'user_id'`,
  `MssqlDatabase.withTenant(…, userId)` and `withUser`); sessions record how the second factor
  was verified; tokens are global; Entra SSO settings and identity links; project logos; role
  permissions; and owner procedures for what runs before any context (lookup by e-mail, a
  person's organisations, lockout after failed attempts, session revocation, SSO lookups).

- **Sessions, people, organisations and projects** (`src/auth/sessions-store.mssql.ts`,
  `src/users/people-store.mssql.ts`, `src/projects/projects-store.mssql.ts`, `mssql/0012`): a
  session found by its token with the person's standing and roles; one-time tokens that work once
  even when two race; invitations that create or link a global account; roles replaced as a set;
  the organisation's settings and role changes; projects with settings merged on update and logos
  kept apart from the project row.

- **Sign-in service** (`src/auth/identity-store.mssql.ts`): second-factor codes that work once even
  when two race, links to an external identity, and an organisation's Microsoft sign-in with its
  domains claimed one organisation at a time.
- **Schema parity** (`apps/api/test/schema-parity.test.ts`, runs without a database): every table
  and column of the PostgreSQL schema exists in the T-SQL migrations. Types, constraints and
  indexes are not compared.

**The switch, step 1 (done):** `DB_ENGINE=postgres|mssql` (`src/config.ts`), with `Engine`
(`src/db/engine.ts`) giving the modules that have moved their SQL Server database. The whole
application boots on SQL Server (`apps/api/test/mssql/boot.test.ts`), its health check answers from
SQL Server and its migrations run at start. PostgreSQL's clients connect lazily, so a module that
has not moved fails only when it is used. Production refuses `mssql` until every module has moved.

**The switch, step 2 (done): sign-in and the session guard.** `AuthRepo`
(`src/auth/auth-repo.ts`) holds what `AuthService` and `AuthGuard` need from the database, with a
PostgreSQL side (the code they had) and a SQL Server side (the stores), so the business rules are
written once; `SsoConfigs` asks SQL Server when it is the engine. Over HTTP on SQL Server
(`apps/api/test/mssql/auth-http.test.ts`, with the harness in `test/mssql/harness.ts`): sign-in,
`/me`, sign-out with CSRF, the second factor (each code once), lockout, idle and deactivated ends,
and switching organisation. Not yet on SQL Server in that module: setting up the second factor,
password change and reset, invitations and Microsoft sign-in. **This pattern is the one for every
module:** a repository interface per module, a PostgreSQL implementation (the existing code, moved)
and a SQL Server one (the stores), so the PostgreSQL suite keeps proving the rules while the HTTP
tests on SQL Server prove the stores.

**The switch, step 3 (done): organisation and projects** (`OrgRepo`, tests over HTTP on SQL Server in
`apps/api/test/mssql/org-http.test.ts`).

**The switch, step 4 (in progress): the rest, module by module, tests last.** Each module gets a
repository (a PostgreSQL side with the code it had, a SQL Server side with the stores and direct
queries); the new HTTP tests on SQL Server are written at the end, with the port of the PostgreSQL
fixtures. Moved so far (code only; the PostgreSQL suite proves the rules): teams (`TeamsRepo`),
audit listing, people of the organisation and of a project (`UsersRepo`), the rest of sign-in
(`AccountTx`: second-factor setup, invitations, password reset, Microsoft sign-in; migration
`0013_tokens.sql` adds the owner procedures for tokens and identities that run before any
context), questionnaires, collaboration and the question library (`QuestionnairesRepo`), cases,
assignment rules and expiry (`CasesRepo`; `CasesService` takes a transaction of either engine, and
wraps a Drizzle one for modules that have not moved). **Still on PostgreSQL:** sample imports and
the sampling selector, interviews and CAPI, CATI, review, web surveys (CAWI, dispatcher,
feedback), paper (PAPI, scans), metrics and goals, the live dashboard, geolocation, privacy,
analysis and sharing, statistics and the bi service, exports, background jobs (sweeper, claims,
worker). Production keeps refusing `mssql` until they move.

**Left:** stores for metrics, jobs, dashboard, geolocation and privacy. The
switch itself goes module by module, each tested over HTTP on SQL Server: the core first (sign-in,
users, organisations, projects, teams, audit), then questionnaires, cases and sampling, interviews
and CATI, web surveys, paper, review, statistics and exports. A fixtures helper that works on both
engines replaces the raw PostgreSQL SQL the integration tests use today. Then the data copy, load
measurements and the removal of PostgreSQL (phases 4 and 5).

More lessons: a `Date` parameter travels as `datetime`, which rounds to 3.33 ms, so what is
written to or compared with a `datetimeoffset(3)` can land a millisecond off: send instants
through `instant()` (`src/db/mssql/instant.ts`). Auditing the first migrations against the
PostgreSQL schema found the kernel behind it (accounts per organisation, no `projects.settings`):
compare each new T-SQL table with `src/db/schema.ts`, not with the first migration it came from.

Lessons from the analysis model: `OPENJSON` returns `key` and `value` in `Latin1_General_BIN2`, so
mixing them with ordinary columns in a `UNION` or `CASE` fails (cast to `DATABASE_DEFAULT`);
`JSON_VALUE` and `OPENJSON` raise an error on text that is not JSON, and SQL Server does not
promise a `WHERE` runs before them, so guard with `CASE WHEN type = … THEN …`; an aggregate may
not mix a local column with an outer one (error 8124); a recursive CTE over `OPENJSON` walks
nested rosters; there is no variadic `md5` (keys are `HASHBYTES('MD5', …)` of the parts joined
with `|`); `THROW` inside a transaction with `XACT_ABORT ON` ends it, so a test that expects the
message calls the procedure outside a transaction.

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
