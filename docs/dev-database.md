# A development database without Docker

WanSurvey runs on SQL Server only: row-level security through `SESSION_CONTEXT`, stored procedures,
`OPENJSON`, application locks, views and triggers are part of how it works. There is no fake
SQL Server (an emulator that reproduced all that would be the engine itself), so for development
and tests the closest thing is **the real engine, on your machine, with a database you can throw
away**.

## 1. A SQL Server on your machine

Any edition works for development; the free ones are enough.

| System              | How                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ubuntu / Debian** | Microsoft's repository, then `sudo apt-get install -y mssql-server` and `sudo /opt/mssql/bin/mssql-conf setup` (choose **Developer**, set the `sa` password). It listens on TCP 1433.                                                                              |
| **Windows**         | SQL Server 2022 **Developer** or **Express**. In the installer choose _Mixed Mode_ (SQL logins) and set the `sa` password; then in _SQL Server Configuration Manager_ → _SQL Server Network Configuration_ enable **TCP/IP** on port 1433 and restart the service. |
| **macOS**           | SQL Server has no native build. Use a Linux virtual machine, a SQL Server on another computer, or an Azure SQL database (the free offer is enough).                                                                                                                |

Notes:

- **LocalDB does not work.** The driver connects by TCP with SQL logins (`user:password`), not by named pipe or Windows login.
- The migrations create a _contained_ database user, which needs a login with **sysadmin** rights (`sa` is the simplest) while they run. The application then connects as the restricted user `wansurvey_app`, under the security policies, as in production.
- On a shared SQL Server use your own login and database name (below); the command never touches a database other than `DEV_DB_NAME`.

## 2. The database

```
export DEV_DB_ADMIN_URL='mssql://sa:<password>@localhost:1433/master?trustServerCertificate=true'
pnpm --filter @wansurvey/api db:dev
```

(In PowerShell: `$env:DEV_DB_ADMIN_URL = '...'`.) `trustServerCertificate=true` is for a local server with its own certificate; do not use it elsewhere. A `@` or `!` in the password is written `%40`, `%21`.

It creates `wansurvey_dev` if it is missing, applies the migrations, loads the demo data (two organisations with a user for every role, a published questionnaire and 50 cases; the password is `SEED_PASSWORD`, `demo-password-123` by default) and prints two lines for `apps/api/.env`:

```
DATABASE_URL=mssql://wansurvey_app:<generated>@localhost:1433/wansurvey_dev?trustServerCertificate=true
DATABASE_ADMIN_URL=mssql://sa:<password>@localhost:1433/wansurvey_dev?trustServerCertificate=true
```

| To                                   | Do                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Start again from nothing             | `pnpm --filter @wansurvey/api db:dev -- --reset`                                                                 |
| Remove it                            | `pnpm --filter @wansurvey/api db:dev -- --drop`                                                                  |
| Skip the demo data                   | add `--no-seed`                                                                                                  |
| Another database name                | `DEV_DB_NAME=wansurvey_x`                                                                                        |
| A fixed password for `wansurvey_app` | `DEV_DB_APP_PASSWORD=…` (otherwise a new one is generated and set on every run: copy the printed `DATABASE_URL`) |
| Bigger demo data                     | `pnpm --filter @wansurvey/api db:seed-demo` afterwards (see `docs/operations.md`)                                |

## 3. Run it

With the two lines in `apps/api/.env` (see `apps/api/.env.example` for the rest, and Redis if you want the worker; without `REDIS_URL` the jobs run inside the API):

```
pnpm dev        # API on :3000 and the web app on :5173
```

Sign in as `project.manager@demo.wansurvey.test` with the demo password. For Microsoft sign-in in development, set the `ENTRA_*` settings and `INITIAL_ADMIN_USER` as in `docs/sso-entra.md`, on a database with no organisations (`--no-seed`).

## 4. For the tests

The SQL Server tests (`apps/api/vitest.mssql.config.ts`) take two variables. They create the database if it is missing, apply the migrations and set the password of `wansurvey_app` to the one in `MSSQL_URL`, so there is nothing to prepare:

```
export MSSQL_ADMIN_URL='mssql://sa:<password>@localhost:1433/wansurvey_test?trustServerCertificate=true'
export MSSQL_URL='mssql://wansurvey_app:<any password>@localhost:1433/wansurvey_test?trustServerCertificate=true'
pnpm --filter @wansurvey/api test:mssql
```

Use a database of its own (not `wansurvey_dev`): the tests leave their data behind, and some need a database with no organisations. `DEV_DB_NAME=wansurvey_test pnpm --filter @wansurvey/api db:dev -- --drop` removes it.
