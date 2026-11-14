# Step 2: apply the migrations, with the names you choose

With the database and its owner made (step 1: `01-create-database.sql` for a new database, or
`01-existing-database.sql` for one that already exists, which creates nothing and adds the tables
in their own schema beside whatever is there), the application makes the **schema**, its tables,
the security policy, the grants, the **application user** and, if you ask for one, a **read-only
user**, with the owner login. Everything you name is in settings:

| Setting                 | What it is                                                                                   | Default  |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------- |
| `DATABASE_ADMIN_URL`    | the owner of step 1 (used only to migrate and to make the first administrator)               | none     |
| `DATABASE_URL`          | the application: **its user name and password are the ones the migration creates**           | required |
| `DATABASE_SCHEMA`       | the schema of the tables, procedures and views (the `rls` and `bi` schemas keep their names) | `dbo`    |
| `DATABASE_READONLY_URL` | optional: a user that reads schema `bi` only, with the name and password in this URL         | none     |

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
- **Reader** (`DATABASE_READONLY_URL`): `SELECT` on schema `bi` (the analysis model, filled by the
  application on a schedule); explicit `DENY` of everything else in `bi` and of everything in the
  application's schema, so a later broad grant to a role cannot open them. The personal questions are
  marked in `bi.dim_pregunta.personal` (see `docs/bi.md`).

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
   `01-existing-database.sql`, with `OwnerLogin="keep"` to use the current owner). With users made from
   logins you need nothing else from step 1: it only turns on contained users, which they do not use.
3. Migrate with `DATABASE_ADMIN_URL` (the owner), `DATABASE_URL` and `DATABASE_READONLY_URL` (the
   user names), `DATABASE_SCHEMA` and `DATABASE_MANAGE_USERS=false`. It stops with a clear message if a
   user does not exist or its default schema is not the schema.
4. `04-check-permissions.sql` to check what was granted.

## The installation wizard (no `DATABASE_URL` yet)

While `DATABASE_URL` is not set, the application does not stop: it runs **only a wizard**, and every
page of the web app leads to `/setup`. It asks for what is not secret: the SQL Server address and
port, the database, the schema, and the names of the owner, the read/write user and the read-only
user (never a password). It answers with:

1. the script that creates the tables (schema, tables, row-level security; one transaction);
2. the script that creates the users and grants the permissions (or only checks the users, if the
   DBA makes them), which asks for the passwords as `sqlcmd` variables when you run it;
3. the settings to put in the environment (`DATABASE_URL` and the others, with `<password>` where the
   password goes).

Run (1), then (2), set the environment (passwords in a vault) and restart: with `DATABASE_URL` set the
wizard is gone. It writes nothing and connects to nothing; what it returns is the same as
`db:script --part tables` and `--part users`, which you can run yourself.

## One SQL file instead of running the application's migration (`db:script`)

If your DBA wants to read and run a file, generate **one `.sql`** with your names already in it
(from the repository; nothing connects to a database):

```
pnpm --filter @wansurvey/api db:script --schema survey --app-user survey_rw \
    --readonly-user survey_ro --out wansurvey.sql          # users made by the script
pnpm --filter @wansurvey/api db:script --schema survey --app-user survey_rw \
    --readonly-user survey_ro --users-by-dba --out wansurvey.sql   # users made by the DBA
# --part tables / --part users: two files, (1) the tables and (2) the users and permissions
```

The names default to `DATABASE_SCHEMA` and to the users in `DATABASE_URL` and
`DATABASE_READONLY_URL`; `--users-by-dba` is also `DATABASE_MANAGE_USERS=false`. Then, as the owner of the database:

```
sqlcmd -S <server> -U <owner> -P <password> -d <database> -b -i wansurvey.sql ^
       -v AppPassword="..." ReaderPassword="..."       # without --users-by-dba; otherwise no -v
```

It does the same as the migration: the schema, the users (or a check that they exist with the schema
as default), the tables, the row-level security, the grants and the record in `<schema>.__migrations`.
The passwords are `sqlcmd` variables, never written in the file. It is **one transaction**: if a
statement fails nothing is kept, and it refuses to run again over what it made. For an upgrade,
generate one with `--from <number>` (the first migration the database lacks, for example `--from 0030`): it checks that the database
is at the one before. Applying it, or running the application's migration, leaves the same database;
do not mix them on one database unless you know which migrations each applied (both use
`__migrations`).

## Scripts to make and check the users by hand

Optional, for a DBA who wants to make the users and verify them (run them as the owner, in the
database; the usage is at the top of each file). They do what the migrations do for the users, and
are safe to repeat:

- `03-users.sql`: makes or updates the schema, the read/write user and the read-only user (password,
  default schema, the reader's `GRANT`/`DENY`). The tables' grants of the read/write user come from the
  migrations, never from here.
- `04-check-permissions.sql`: changes nothing; lists the users, roles and permissions and checks the
  least-privilege rules (no role, nothing on schemas, no write on the audit log; the reader sees only
  `bi`). It fails with a `FAIL` line if a permission was changed outside the migrations.
- `05-drop-users.sql`: removes a user (to retire the reader); refuses the read/write user.

The seed of demonstration data (`pnpm db:seed`, `pnpm db:seed-demo`) and the load-test setup work in
the schema in `DATABASE_SCHEMA`: export it, with `DATABASE_ADMIN_URL`, when you run them.
