# Step 2: apply the migrations, with the names you choose

With the database and its owner made (step 1), the application makes the **schema**, its tables,
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

The seed of demonstration data (`pnpm db:seed`) and the load-test setup are development tools and
need the schema `dbo`.
