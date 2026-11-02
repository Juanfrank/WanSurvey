# WanSurvey, development copy

For trying the application out, with nothing to set up but Docker and Node 24. **Not for production**: the
demo users have a public password and the SQL Server is a throwaway container.

```
./start-dev.sh          (Linux, macOS)
start-dev.cmd           (Windows)
```

It starts a SQL Server in a Docker container (`wansurvey-dev-mssql`, port 14330 on this computer), waits
for it, creates the database `wansurvey_dev` with the migrations and the demo data, and starts the
application with the web app on <http://localhost:3000>.

Sign in as `project.manager@demo.wansurvey.test` with the password `demo-password-123` (other demo users:
`owner`, `admin`, `supervisor`, `reviewer`, `interviewer`, `client.viewer`, all `@demo.wansurvey.test`).

| To                                           | Do                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Stop the application                         | Ctrl+C (the SQL Server keeps running: the next start is quick and keeps your data) |
| Start again from the demo data               | `node dev-start.mjs --reset`                                                       |
| Remove the SQL Server and its data           | `node dev-start.mjs --down`                                                        |
| Leave the demo data out                      | `--no-seed` (with `--reset` the first time)                                        |
| Another port                                 | `DEV_PORT=3100`, `DEV_DB_PORT=14331`                                               |
| Another image (for example on Apple silicon) | `DEV_SQL_IMAGE=...`                                                                |

What stays between runs is in `.dev/` (the generated passwords and the encryption key, and the files the
app writes). Delete the folder together with the container (`--down`) to start from nothing.

E-mail is written to the log (`MAILER=console`). Microsoft sign-in is not set up here; with a directory of
your own, set the `ENTRA_*` settings in the environment before starting (see `docs/sso-entra.md` in the
repository).

The SQL Server image is Microsoft's (`mcr.microsoft.com/mssql/server`); starting it means accepting its
licence terms (`ACCEPT_EULA=Y`), which allow it for development and testing.
