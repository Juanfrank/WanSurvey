# Step 2: apply the migrations, with the names you choose

With the database and its owner made (step 1: `01-create-database.sql` for a new database, or
`01-existing-database.sql` for one that already exists, which creates nothing and adds the tables
in their own schema beside whatever is there), the application makes the **schema**, its tables,
the security policy, the grants, the **application user** and, if you ask for one, a **read-only
user**, with the owner login. Everything you name is in settings:

| Setting                 | What it is                                                                                                                   | Default  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| `DATABASE_ADMIN_URL`    | the owner of step 1 (used only to migrate and to make the first administrator)                                               | none     |
| `DATABASE_URL`          | the application: **its user name and password are the ones the migration creates**                                           | required |
| `DATABASE_SCHEMA`       | the schema of everything: tables, views, procedures, functions and the security policy (nothing is made in any other schema) | `dbo`    |
| `DATABASE_READONLY_URL` | optional: a user that reads only the analysis model (`bi_` tables and views), name and password in this URL                  | none     |

```
DATABASE_ADMIN_URL="mssql://survey_owner:<OwnerPassword>@<server>:1433/survey_prod?trustServerCertificate=true"
DATABASE_URL="mssql://survey_rw:<RwPassword>@<server>:1433/survey_prod?trustServerCertificate=true"
DATABASE_READONLY_URL="mssql://survey_ro:<RoPassword>@<server>:1433/survey_prod?trustServerCertificate=true"
DATABASE_SCHEMA=survey
node dist/db/migrate.js        # in the API image; from the repository: pnpm --filter @wansurvey/api db:migrate
```

(The application also runs the migrations when it starts, if `DATABASE_ADMIN_URL` is set.)

Names are letters, digits and underscores. **Choose the schema and the user name before the first
migration and keep them**: the migrations are recorded as applied, and a later change of schema or
user would find the objects where they were. The passwords can change at any time: the next
migration run sets the new one from the URL.

What the users may do, checked on SQL Server 2022:

- **Application** (`DATABASE_URL`): no role; only what the migrations grant, table by table and procedure
  by procedure; under row-level security by organisation (without an organisation in context it sees no
  row); it cannot create or alter anything and cannot change the audit log.
- **Reader** (`DATABASE_READONLY_URL`): `SELECT` on the analysis model (the `bi_` tables and views of the
  schema, filled by the application on a schedule); explicit `DENY` of `SELECT` on every other table and
  view and of `INSERT`, `UPDATE`, `DELETE`, `EXECUTE` and `ALTER` on the schema, so a later broad grant to a
  role cannot open them. The personal questions are marked in `bi_dim_pregunta.personal` (see `docs/bi.md`).

## When the DBA makes the users (`DATABASE_MANAGE_USERS=false`)

If the users are the DBA's to make, set `DATABASE_MANAGE_USERS=false`. The migrations then make
**only the schema and the tables, and grant the permissions** to the users that already exist; they
create no user, change no password and touch neither the containment of the database nor any server
setting (so the owner needs no server permission at all). The passwords stay out of the application's
settings for the migration (the URLs still carry the user names).

1. The DBA makes the two users, of any kind (contained with a password, or mapped from a login), with
   the schema as default schema: `03-users.sql` does it for contained users; for logins:

   ```sql
   CREATE USER [survey_rw] FOR LOGIN [survey_rw] WITH DEFAULT_SCHEMA = [survey];
   CREATE USER [survey_ro] FOR LOGIN [survey_ro] WITH DEFAULT_SCHEMA = [survey];
   ```

   The schema need not exist yet; the migrations make it.

2. The login in `DATABASE_ADMIN_URL` must be the **owner of the database** (it is `dbo` in it: see
   `01-existing-database.sql`, with `@owner = N'keep'` to use the current owner). With users made from
   logins you need nothing else from step 1: it only turns on contained users, which they do not use.
3. Migrate with `DATABASE_ADMIN_URL` (the owner), `DATABASE_URL` and `DATABASE_READONLY_URL` (the
   user names), `DATABASE_SCHEMA` and `DATABASE_MANAGE_USERS=false`. It stops with a clear message if a
   user does not exist or its default schema is not the schema.
4. `04-check-permissions.sql` to check what was granted.

## The installation wizard (no `DATABASE_URL` yet)

While `DATABASE_URL` is not set, the application does not stop: it runs **only a wizard**, and every
page of the web app leads to `/setup`. It asks for what is not secret: the SQL Server address (with the port only if it is not the default: `host` or `host:1434`), the database, the schema, and the names of the owner, the read/write user and the read-only
user (never a password). It answers with:

1. the script that creates the structure (schema, tables, views, procedures and row-level security, as plain `CREATE` statements, with no history of migrations; one transaction);
2. the script that creates the users and grants the permissions (or only checks the users, if the
   DBA makes them), which asks for the passwords in `DECLARE` lines at its top, that you fill in before running it;
3. only if some migration is newer than that structure, a script with those migrations;
4. the settings to put in the environment (`DATABASE_URL` and the others, with `<password>` where the
   password goes).

Run (1), then (2) and set the environment (passwords in a vault); with `DATABASE_URL` set the wizard
is gone after a restart. It writes nothing and connects to nothing; what it returns is the same as
`db:script --part tables` and `--part users`, which you can run yourself.

### The wizard while the database is not ready

The wizard also runs when `DATABASE_URL` **is** set but the database cannot be used yet: with nobody to
migrate (no `DATABASE_ADMIN_URL`), or when the owner's migrations fail at start (the server cannot be
reached, the owner is refused, for example because the database does not exist yet, or a migration
fails: the error is in the log). In that last case it retries the migrations every 10 seconds. It then shows where the installation stands, seen with the
application's own user: the server answers; the user can sign in (script 2 makes it); the user can
read the tables (scripts 1 and 2). It asks again every 10 seconds (and with "Check again"), and when
everything is ready it **starts the application by itself, with no restart**; the page then goes to
the sign-in. Nothing is written by the check, and it publishes no name, address or user. The worker
process, with no `DATABASE_URL`, waits instead of failing. With `DATABASE_ADMIN_URL` set and working, the
application migrates at start and runs, as before. A wrong configuration (a missing required setting)
still stops the process with its message: that is not the state of the database.

## SQL files instead of running the application's migration (`db:script`)

If your DBA wants to read and run files, generate them with your names already in (from the
repository; nothing connects to a database). A new installation does **not** replay the history of
migrations: it takes the **baseline** (`apps/api/mssql/baseline.sql`), the structure that the
migrations leave, written as plain `CREATE` statements. Three files, in this order:

```
pnpm --filter @wansurvey/api db:script --schema survey --app-user survey_rw --readonly-user survey_ro \
    [--users-by-dba] --part tables  --out 1-tables.sql       # (1) the schema and the whole structure
pnpm --filter @wansurvey/api db:script ... --part users      --out 2-users.sql        # (2) the users and the permissions
pnpm --filter @wansurvey/api db:script ... --part migrations --out 3-migrations.sql   # (3) only if some are newer
```

(`--part all` makes one file with all of it.) The names default to `DATABASE_SCHEMA` and to the users in
`DATABASE_URL` and `DATABASE_READONLY_URL`; `--users-by-dba` is also `DATABASE_MANAGE_USERS=false`. Run each
as the owner of the database, with any T-SQL client (SSMS, Azure Data Studio, the query editor of
the Azure portal, `sqlcmd -i` as well): each file is **plain T-SQL**, one batch with no `GO` and no
`sqlcmd` variables, so it runs the same everywhere. In `2-users.sql` (unless `--users-by-dba`) write the
passwords in the `DECLARE @AppPassword` / `@ReaderPassword` lines at the top before running it; the
file refuses to run while a placeholder is still there. The `01-…` and `03-…` to `05-…` scripts of this
folder work the same way: the values to write are in the `DECLARE` lines at their top.

- **(1) The structure** is one transaction: if a statement fails nothing is kept, and it refuses to run
  twice. It records what the baseline covers in `<schema>.__migrations`.
- **(2) The users and permissions** needs (1), and can be run again (to change a password, or to grant
  the read-only user the tables a later migration added).
- **(3) The migrations** are only the ones **newer than the baseline**: when the repository has none,
  `--part migrations` says there is nothing to do and the wizard does not offer it. It has its own
  permissions, needs (1) and (2), and refuses to run twice. A database made before the baseline, or by
  an older release, is brought up to date with `--from <number>` (the first migration it lacks): it
  checks that the database is at the one before.

The baseline is regenerated at each release (`docs/releasing.md`) with `db:baseline`, and a test checks
that a database made from it equals one made by replaying the migrations (tables, columns in order,
constraints, indexes, views, procedures, triggers, security policies, permissions and the data it
fills). The application, when it runs the migrations itself (`DATABASE_ADMIN_URL`), takes the same
baseline on a new database. Do not mix files and the application's migration on one database unless
you know which migrations each applied (both use `__migrations`).

## Scripts to make and check the users by hand

Optional, for a DBA who wants to make the users and verify them (run them as the owner, in the
database; the usage is at the top of each file). They do what the migrations do for the users, and
are safe to repeat:

- `03-users.sql`: makes or updates the schema, the read/write user and the read-only user (password,
  default schema, the reader's `GRANT`/`DENY`). The tables' grants of the read/write user come from the
  migrations, never from here.
- `04-check-permissions.sql`: changes nothing; lists the users, roles and permissions and checks the
  least-privilege rules (no role, nothing on schemas, no write on the audit log; the reader sees only
  the `bi_` objects). It fails with a `FAIL` line if a permission was changed outside the migrations.
- `05-drop-users.sql`: removes a user (to retire the reader); refuses the read/write user.

The seed of demonstration data (`pnpm db:seed`, `pnpm db:seed-demo`) and the load-test setup work in
the schema in `DATABASE_SCHEMA`: export it, with `DATABASE_ADMIN_URL`, when you run them.
