# Roadmap

Planned work that is not built yet. Each item says why, what it takes and in what order.

## Done: SQL Server replaced PostgreSQL

SQL Server is the only database. The data layer is Kysely with tedious (`apps/api/src/db/mssql/`),
the migrations are T-SQL (`apps/api/mssql/`, 16 files), isolation by organisation is a security
policy on `SESSION_CONTEXT`, and every module reads and writes through `*-repo.ts` interfaces with
SQL Server implementations (`Mssql*Repo`, stores in `*-store.mssql.ts`). PostgreSQL, Drizzle, the
PostgreSQL migrations, the data-copy tool and the k6 load scripts were removed; they are in the
git history (the copy tool at commit `3484e04`; see [`data-copy.md`](data-copy.md)).

What proves it: job `sqlserver` runs the API tests that need a database (about 775) on a SQL Server
2022 container, job `e2e` runs the browser tests with the API on SQL Server, and job `package`
starts the App Service zip against a new SQL Server database.

Accepted on the way:

- **Time precision**: instants are `datetimeoffset(3)`, milliseconds, where PostgreSQL kept
  microseconds.
- **Ordering of equal times**: ties are broken by creation order through the UUIDv7 text
  (`db/mssql/order.ts`), because SQL Server sorts a `uniqueidentifier` differently.
- **No production data existed**, so no data was moved and no rehearsal on a production snapshot
  was needed.

## Still open

- **Load measurements on Azure SQL.** The old k6 numbers were measured on PostgreSQL and were
  removed with it. Measure again, with new scripts, on the real tier before large waves; size
  `DB_POOL_MAX` and `DB_WORKER_POOL_MAX` against that tier's session and worker limits
  ([`concurrency.md`](concurrency.md)).
- **SQLite for test instances (undecided).** The idea was a file database for trial deployments
  and demos while SQL Server environments are prepared. It would never be production and never
  hold real data (no row-level security, no row locks). With SQL Server 2022 available as a
  container (`docker compose up -d mssql mssql-init`), it is probably not worth a second dialect;
  it stays here until someone needs a server-less instance.
- **Lint warnings.** 16 `react-hooks/exhaustive-deps` warnings remain in the web app and the
  renderer: effects that run on purpose only when one value changes. Each needs a look on its
  own before dependencies are added, so none was changed blindly.
- **Dependencies.** Updates wait until they are two weeks old. Major versions waiting for a
  decision: NestJS 12, React 19, ESLint 10 with `eslint-plugin-react-hooks` 7, Vitest 4 (it
  also brings the fixed `tinypool`, see below), TypeScript 7, tedious 20, bullmq 6, ioredis 6,
  pino 10.
- **Advisories in development tools only** (the CI audit covers production dependencies and
  passes): `tinypool` under Vitest 3 (fixed in Vitest 4), and `follow-redirects` and `uuid`
  under Azurite (`follow-redirects` 1.16.2 is out; it becomes eligible on 8 November).
