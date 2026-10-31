# Copying the data from PostgreSQL to SQL Server

Phase 4 of `docs/roadmap.md`. The tool is in `apps/api/src/db/copy/`; CI rehearses it on every push (job
`data-copy`), and it was tried locally on the browser-test database and on a 1.8-million-row one.

## What it does

`copy.ts` reads both schemas (`information_schema` on PostgreSQL, `sys.*` on SQL Server) and copies every table
the two have, column by column, so it follows the schemas as they change. A table or column that exists on one
side only is reported and left out. Tables go in foreign-key order, with the constraints off while the data
loads and switched back on (and every row checked) at the end; a row that breaks one is listed with
`DBCC CHECKCONSTRAINTS`, not just refused.

Rows travel as JSON, in batches of up to 2000 rows or 8 MB, and are inserted with `OPENJSON … WITH (…)`, so every
column arrives as the exact type SQL Server stores. PostgreSQL values are selected as text: `uuid`, numbers and
dates as text, `jsonb` as its text, arrays as JSON arrays, `bytea` as hex, booleans as 0/1, instants as UTC to the
millisecond.

The target must be empty (a database only the migrations have touched); otherwise the tool refuses unless
`COPY_APPEND=1`. It never writes to the source.

## Running it

```sh
cd apps/api && pnpm build
export SOURCE_DATABASE_URL=postgres://…            # an owner of the PostgreSQL database
export TARGET_DATABASE_ADMIN_URL=mssql://…         # an owner of the new, migrated SQL Server database
node dist/db/copy/cli.js plan      # tables and columns that will be copied, and those that will not
node dist/db/copy/cli.js copy      # COPY_SKIP=sessions,… / COPY_ONLY=… narrow it
node dist/db/copy/cli.js verify    # counts, id fingerprints, and 100 rows per table compared field by field
```

`dist/db/copy/rehearse.js` does all of it on a throwaway target (it drops and creates a database whose name ends
in `_copy` or `_rehearsal`, applies the T-SQL migrations, copies and verifies), for trying the copy on a snapshot
before the real one. `scripts/make-copy-source.mjs` builds a demo PostgreSQL source.

The application keeps `APP_ENCRYPTION_KEY`: sealed personal fields and secrets are copied as they are and decrypt
with the same key.

## What was measured

- Browser-test database (about 1,300 rows, 51 tables): 3 s.
- 1.83 million rows in 51 tables, 1 GB in PostgreSQL (audit log, cases, interviews, call attempts, case events,
  contacts): copy 253 s, about 7,200 rows/s on one connection; copy plus verification, 5 min 10 s. Every table
  matched: counts, fingerprints of the ids, and the samples.
- `scripts/engine-parity.sh` starts the API on each engine over the same data and calls 118 read endpoints as the
  same person (including reading cases with personal data revealed, which proves the sealed values decrypt, and
  building the CSV export on both): 103 identical, 13 absent on both, the rest explained below.

## Known differences

- **Instants keep the millisecond.** PostgreSQL holds microseconds; the T-SQL columns are `datetimeoffset(3)`.
  What was told apart by microseconds is tied after the copy (a case history with two events in one millisecond
  can list them in the other order), and a duration computed from two instants can differ in the third decimal
  (`1.816802` s against `1.816` s).
- **JSON written twice.** Where SQL Server requires a JSON document (`CHECK (ISJSON(col) = 1)`) and PostgreSQL holds a
  JSON _string_ whose text is itself a document, the copy stores the inner document and counts it
  ("N JSON values unwrapped"); `verify` understands it. Anything else that breaks a constraint is reported with the
  rows, and the copy stops.
- **The SQL export is written in the dialect of the engine behind the API**, so the script from one engine is not
  the other's.
- **Ties in a list ordered by time** are broken by the text of the id (UUIDv7: creation order), as PostgreSQL's
  `uuid` order gave; SQL Server sorts a `uniqueidentifier` by its last bytes first (`db/mssql/order.ts`).

## For the real move

Rehearse on a restored snapshot of production first; read the counts and the "unwrapped" lines; stop the
application (or use a maintenance window) so nothing is written to PostgreSQL between the copy and the
switch; copy; `verify`; point `DATABASE_URL` and `DB_ENGINE=mssql` at the new database. The speed above is on one
connection to a local SQL Server; Azure SQL will be slower per round trip, and several tables can be copied at
the same time if the window is short (not done yet).
