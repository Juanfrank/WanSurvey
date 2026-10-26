# Operations

How to run WanSurvey in production: what runs, how it is configured, and the routine tasks.

## What runs

| Process     | Image / command                                        | Scale                          | Needs                          |
| ----------- | ------------------------------------------------------ | ------------------------------ | ------------------------------ |
| Web         | `apps/web/Dockerfile` (nginx, port 8080)               | 2+ behind the load balancer    | —                              |
| API         | `apps/api/Dockerfile`, `node dist/main.js` (port 3000) | 2+                             | Postgres, Redis                |
| Worker      | same image, `node dist/worker.js`                      | 1–2 (jobs are taken once each) | Postgres, Redis                |
| Postgres 16 | managed service                                        | primary + standby              | encrypted disks, daily backups |
| Redis 7     | managed service                                        | 1 (with persistence)           | —                              |

TLS terminates at the load balancer, which sends `/` to the web containers. nginx serves the app with its security headers and proxies `/api/` to the API, so the session cookie stays first-party. Server-Sent Events (`/api/v1/projects/:id/live`) need proxy buffering off and a long read timeout; `infra/nginx/templates/default.conf.template` sets both, and a load balancer in front needs an idle timeout above 30 s.

On Azure App Service, see [`azure.md`](azure.md). `docker compose --profile full up` runs the whole stack locally (Postgres, Redis, API, worker, web on http://localhost:8080).

## Configuration

API and worker read the same environment (validated at start; see `apps/api/.env.example`):

| Variable                                                             | Notes                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                       | Restricted role `wansurvey_app` (row-level security applies)                                                                                                                             |
| `DATABASE_ADMIN_URL`                                                 | Owner role, for migrations only                                                                                                                                                          |
| `APP_ENCRYPTION_KEY`                                                 | 32 bytes, base64. Encrypts TOTP secrets, SSO secrets, respondent and share tokens, and personal sample fields. **Losing it loses that data**: keep it in a secrets manager with a backup |
| `REDIS_URL`                                                          | Jobs and live updates. Required for the worker                                                                                                                                           |
| `PUBLIC_WEB_URL`, `API_PUBLIC_URL`                                   | Links in e-mails; the Microsoft redirect                                                                                                                                                 |
| `MAILER`, `SMTP_URL`, `MAIL_FROM`, `MAIL_WEBHOOK_SECRET`             | E-mail and the bounce webhook                                                                                                                                                            |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `LOGIN_RATE_LIMIT` | Session and login limits                                                                                                                                                                 |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`                          | Optional error and trace export                                                                                                                                                          |

## Deploying a version

1. Build both images from the same commit.
2. Run migrations once: `node dist/db/migrate.js` in the API image, with `DATABASE_ADMIN_URL` and `DATABASE_URL` set (it also keeps the restricted role up to date). Migrations are additive and run before the new code starts.
3. Roll out the API and the worker, then the web image.
4. Check `/health` (database included) and the worker's log line `Worker listening on queue wansurvey`.

## Background jobs

| Job                 | When                                                     | What                                                                                                     |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `mail.dispatch`     | every 15 s                                               | Sends queued invitations and due reminders, up to 200 per organisation per run                           |
| `stats.refresh`     | after each submission or review decision (debounced 1 s) | Recomputes one project day of `stats_daily`, then announces it to dashboards                             |
| `stats.nightly`     | 02:00 UTC                                                | Recomputes all daily figures                                                                             |
| `exports.build`     | on request                                               | Builds an export file page by page into export storage (up to `EXPORT_MAX_BYTES`, 2 GB)                  |
| `pii.encrypt`       | at worker start, then hourly                             | Seals personal sample fields still in plain text (for example after a field is marked personal)          |
| `privacy.retention` | 02:30 UTC                                                | Removes personal data from cases past their project's retention period                                   |
| `bi.refresh`        | `BI_REFRESH_CRON` (every 6 h at :40 UTC)                 | Refreshes the analysis model, schema `bi` ([bi.md](bi.md)), when its data changed                        |
| `jobs.sweep`        | every 5 minutes                                          | Requeues exports and scanned batches left queued or abandoned by a lost worker; fails them after 3 tries |

Without Redis (App Service from a zip, `docs/appservice-zip.md`) jobs run in the API's process with the same limits: `JOB_CONCURRENCY` light jobs and `HEAVY_JOB_CONCURRENCY` heavy ones at a time, three tries each (`JOB_RETRY_MS`, doubled). Failed jobs retry three times with backoff; the 500 most recent failed jobs (a week at most) are kept in Redis for inspection. Without the worker, e-mail stops, dashboards stop updating and exports stay queued; the API keeps working. Without Redis, the API still answers: jobs are not queued (submissions, exports and uploads go through; the sweeper and the nightly recompute catch up), live notices are skipped and rate limits are counted by each instance on its own (a little looser with several instances, never off).

A locked account (too many failed passwords or codes) opens by itself after `LOGIN_LOCK_MINUTES`; to open it sooner: `update users set locked_until = null, failed_logins = 0 where lower(email) = lower('…');`.

## Backups and restore

- Postgres: daily full backups and point-in-time recovery (WAL), kept 30 days, encrypted at rest. Test a restore every quarter into a separate database and run `pnpm --filter @wansurvey/api test` against it.
- Redis holds only queues and pub/sub; it can be lost. Scheduled jobs are re-created when the worker starts, and a nightly recompute rebuilds the figures.
- `APP_ENCRYPTION_KEY` is backed up separately from the database backups.

## Retention and data subject requests

- Set **Settings → Personal data retention** per project (days after a case is finished). Each night the worker removes the personal data of older finished and withdrawn cases; answers that are not personal stay for statistics. Each case is recorded in the audit log (`case.anonymised`).
- A person asking for their data: open the case → **Personal data → Download what is held (JSON)**. Asking for erasure: **Erase personal data…** with the request reference. Both are in the audit log (`case.subject_exported`, `case.anonymised`).
- Exports already downloaded are outside the system; erasure applies to what WanSurvey holds.

## Monitoring

- `/health` for liveness and database reachability.
- Logs are JSON (pino); cookies and CSRF tokens are redacted.
- Watch: API 5xx rate, p95 latency of `/interviews/sync` and `/public/s/*/submit`, Redis queue length (`bull:wansurvey:wait`), failed jobs, Postgres connections and replication lag.

## Load testing

k6 scripts in `load/` (CAWI burst of 50 completes per second; 300 interviewers syncing). Run them against staging before large waves; see `load/README.md`.
