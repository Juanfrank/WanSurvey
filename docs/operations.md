# Operations

How to run WanSurvey in production: what runs, how it is configured, and the routine tasks.

## What runs

| Process    | Image / command                                        | Scale                          | Needs                     |
| ---------- | ------------------------------------------------------ | ------------------------------ | ------------------------- |
| Web        | `apps/web/Dockerfile` (nginx, port 8080)               | 2+ behind the load balancer    | —                         |
| API        | `apps/api/Dockerfile`, `node dist/main.js` (port 3000) | 2+                             | SQL Server, Redis         |
| Worker     | same image, `node dist/worker.js`                      | 1–2 (jobs are taken once each) | SQL Server, Redis         |
| SQL Server | Azure SQL Database or SQL Server 2022                  | per the service tier           | encryption, daily backups |
| Redis 7    | managed service                                        | 1 (with persistence)           | —                         |

TLS terminates at the load balancer, which sends `/` to the web containers. nginx serves the app with its security headers and proxies `/api/` to the API, so the session cookie stays first-party. Server-Sent Events (`/api/v1/projects/:id/live`) need proxy buffering off and a long read timeout; `infra/nginx/templates/default.conf.template` sets both, and a load balancer in front needs an idle timeout above 30 s.

On Azure App Service, see [`azure.md`](azure.md). `docker compose --profile full up` runs the whole stack locally (SQL Server, Redis, API, worker, web on http://localhost:8080).

## Configuration

API and worker read the same environment (validated at start; see `apps/api/.env.example`):

| Variable                                                             | Notes                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                       | Restricted role `wansurvey_app` (row-level security applies)                                                                                                                             |
| `DATABASE_ADMIN_URL`                                                 | Owner role, for migrations only                                                                                                                                                          |
| `ENCRYPTION_KEY`                                                     | 32 bytes, base64. Encrypts TOTP secrets, SSO secrets, respondent and share tokens, and personal sample fields. **Losing it loses that data**: keep it in a secrets manager with a backup |
| `REDIS_URL`                                                          | Jobs and live updates. Required for the worker                                                                                                                                           |
| `PUBLIC_URL`                                                         | Links in e-mails; the Microsoft redirect                                                                                                                                                 |
| `MAILER`, `SMTP_URL`, `MAIL_FROM`, `MAIL_WEBHOOK_SECRET`             | E-mail and the bounce webhook                                                                                                                                                            |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `LOGIN_RATE_LIMIT` | Session and login limits                                                                                                                                                                 |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`                          | Optional error and trace export                                                                                                                                                          |

## Deploying a version

1. Build both images from the same commit.
2. Run migrations once: `node dist/db/migrate.js` in the API image, with `DATABASE_ADMIN_URL` and `DATABASE_URL` set (it also keeps the restricted role up to date). Migrations are additive and run before the new code starts.
3. Roll out the API and the worker, then the web image.
4. Check `/health` (database included) and the worker's log line `Worker listening on queue wansurvey`.

## Background jobs

| Job                 | When                                                     | What                                                                                                                                       |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `mail.dispatch`     | every 15 s                                               | Sends queued invitations and due reminders, up to 200 per organisation per run                                                             |
| `stats.refresh`     | after each submission or review decision (debounced 1 s) | Recomputes one project day of `stats_daily`, then announces it to dashboards                                                               |
| `stats.nightly`     | 02:00 UTC                                                | Recomputes all daily figures                                                                                                               |
| `exports.build`     | on request                                               | Builds an export file page by page into export storage (up to `EXPORT_MAX_BYTES`, 2 GB)                                                    |
| `pii.encrypt`       | at worker start, then hourly                             | Seals personal sample fields still in plain text (for example after a field is marked personal)                                            |
| `privacy.retention` | 02:30 UTC                                                | Removes personal data from cases past their project's retention period                                                                     |
| `bi.refresh`        | `BI_REFRESH_CRON` (every 6 h at :40 UTC)                 | Refreshes the analysis model, schema `bi` ([bi.md](bi.md)), when its data changed; stands aside once a frequency is set in the application |
| `bi.tick`           | every 10 minutes                                         | Refreshes the analysis model when the frequency set in the application has passed                                                          |
| `jobs.sweep`        | every 5 minutes                                          | Requeues exports and scanned batches left queued or abandoned by a lost worker; fails them after 3 tries                                   |

Without Redis (App Service from a zip, `docs/appservice-zip.md`) jobs run in the API's process with the same limits: `JOB_CONCURRENCY` light jobs and `HEAVY_JOB_CONCURRENCY` heavy ones at a time, three tries each (`JOB_RETRY_MS`, doubled). Failed jobs retry three times with backoff; the 500 most recent failed jobs (a week at most) are kept in Redis for inspection. Without the worker, e-mail stops, dashboards stop updating and exports stay queued; the API keeps working. Without Redis, the API still answers: jobs are not queued (submissions, exports and uploads go through; the sweeper and the nightly recompute catch up), live notices are skipped and rate limits are counted by each instance on its own (a little looser with several instances, never off).

A locked account (too many failed passwords or codes) opens by itself after `LOGIN_LOCK_MINUTES`; to open it sooner: `UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE LOWER(email) = LOWER('…');`.

## Backups and restore

- SQL Server: daily full backups and point-in-time recovery (automatic on Azure SQL Database), kept 30 days, encrypted at rest. Test a restore every quarter into a separate database and run `pnpm --filter @wansurvey/api test:mssql` against it.
- Redis holds only queues and pub/sub; it can be lost. Scheduled jobs are re-created when the worker starts, and a nightly recompute rebuilds the figures.
- `ENCRYPTION_KEY` is backed up separately from the database backups.

## Creating the database with least privilege

`infra/sql/` has the provisioning scripts, tested end to end on SQL Server 2022: `01-create-database.sql`
(the database and its owner login) and `02-migrate.md` (the migrations, run with the owner, which make the
schema, the tables and the two users). Three principals: the **owner** (owns the database, deploys, has no
server role, then disable it), the **application** (no role, only the grants of the migrations, always under
row-level security) and the **reader** (only `SELECT` on schema `bi`). The names are yours: `DATABASE_SCHEMA`
(the schema of the tables; `rls` and `bi` keep theirs), the user of `DATABASE_URL` and the user of
`DATABASE_READONLY_URL`. See `02-migrate.md`.

## About and Privacy pages

`/about` and `/privacy` are public pages (no sign-in), linked from the sign-in page, the account
menu and the foot of every web survey. They say what the application does with data, and they
name the organisation that answers for it from two settings: `ORG_NAME` (the controller) and
`PRIVACY_CONTACT` (an e-mail address or a postal address where people write about their data). The About page also names the
author and the holder of the rights over the application when `APP_AUTHOR` and `APP_HOLDER` are set (they are not the
organisation that runs the installation).
Without them the pages say the organisation that runs the installation answers, and to write to
the person who sent the invitation. **Set both before the first real survey.**

The pages also name the outside services that are on (the SMS provider, Microsoft sign-in,
OpenStreetMap geocoding) and say nothing of those that are off. The text is in
`apps/web/src/about/content.ts`; **the institution's legal area should read it and agree it**
(legal basis, retention periods, transfers and the authority to complain to depend on the
country) before it is published. The legal basis of each survey is a project setting.

## Lawful basis for contacting people

Before calling or visiting, a project declares why it may contact its sample (Settings → Privacy:
consent, legitimate interest, contract or public task), one for telephone and one for visits;
e-mail and SMS have theirs in the web settings. Without it the call queue, the start of a call or
visit interview and the download to a tablet answer 409 `NO_LAWFUL_BASIS`. **After updating, set it
in every project already in the field**, or its interviewers are stopped. Agree the choice with the
institution's legal area; research and official statistics may rest on a public task, marketing
usually does not.

## Information notice

The information notice (who answers for the data, what it is for, that taking part is voluntary,
how to use one's rights) is the first question of the questionnaire: a text with the role
"consent" followed by the yes/no question whose refusal ends the interview. Add it in the designer
with the **Information notice** button of the outline, complete the organisation, the purpose and
the contact in each language, and it is shown, translated, previewed, printed on paper and
exported like any item. A project can require it (Settings → Privacy → "Do not publish a
questionnaire that does not open with the information notice"). **Agree the wording with the
institution's legal area.**

## Terms of use and confidentiality of staff

Every person who works in the application accepts, before using it, the terms of use and the
confidentiality undertaking (`/terms`, also readable without signing in): authorised use only, no
copying of personal data out of the means the organisation authorises, secrecy that outlasts the
job, what is recorded, how to report an incident, consequences. The acceptance is kept with the
version of the text and its date, and in the activity log (`user.terms_accepted`). The text is in
`apps/web/src/about/content.ts` (`termsPage`); when it changes, raise `TERMS_VERSION` in
`packages/schema/src/constants.ts` and everyone is asked again at their next access. **Agree the
wording, and how it fits the employment or service contract, with the institution's legal area.**
It binds only people who use the application's screens: an integration API key is not asked.

## Sensitive data and minors

Mark a question as **sensitive** in the designer (health, racial or ethnic origin, political
opinions, religion, sexual orientation, trade-union membership, biometric or genetic data,
judicial record): it is kept as personal data (masked, encrypted, left out of exports without
`pii.view`), and the questionnaire cannot be published without the information notice; consider an
express-consent question too. Under many laws such data needs a prior impact assessment.

To keep minors out, set a minimum age in Settings → Privacy: the designer offers an **Age screen**
button (a question about age that ends the interview as not eligible, `SCREENED_OUT`, under that
age) and the questionnaire cannot be published without it. The usual age is 18 but depends on the
country. Interviewing minors needs their guardian's consent and a decision of the institution's
legal area; this feature only excludes them.

## Retention and data subject requests

- Set **Settings → Personal data retention** per project (days after a case is finished). Each night the worker removes the personal data of older finished and withdrawn cases; answers that are not personal stay for statistics. Each case is recorded in the audit log (`case.anonymised`).
- A person asking for their data: open the case → **Personal data → Download what is held (JSON)**. Asking for erasure: **Erase personal data…** with the request reference. Both are in the audit log (`case.subject_exported`, `case.anonymised`).
- Auditors: `GET /api/v1/audit-log/export?from=…&to=…[&action=…&actorUserId=…][&format=csv|jsonl]` downloads the activity log of a range (up to 366 days) as a stream. It needs the `audit.export` permission (owners by default; roles are configurable under Administration). Each export is recorded twice in the log (`audit.exported`, at the start and at the end with the row count).
- Exports already downloaded are outside the system; erasure applies to what WanSurvey holds.

## Monitoring

- `/health` for liveness and database reachability; with `HEALTH_ALLOWED_IPS` set it answers only those addresses (`docs/appservice-zip.md`).
- Logs are JSON (pino); cookies and CSRF tokens are redacted.
- Watch: API 5xx rate, p95 latency of `/interviews/sync` and `/public/s/*/submit`, Redis queue length (`bull:wansurvey:wait`), failed jobs, database sessions, blocked requests and replication lag.

## Load testing

### SMS invitations

A web survey wave can go **by SMS** instead of by e-mail (ADR 0001, decision 4): choose _By SMS_ when creating the wave. It uses the same machinery as the e-mail waves (lawful basis declared first, the dispatcher, reminders, the funnel, the personal link) and differs in four things.

- **Who gets it.** Cases with a valid _phone_ contact in E.164 form (`+51987654321`; the import's default country code makes them so), whose consent does not say `sms: false`, and that is not on the do-not-contact list. The preview counts what is left out and why (no number, not E.164, opted out, on the list).
- **When.** Only inside the project's calling hours (**Settings → Telephone interviewing**) in the respondent's time zone (`timezone` of the sample, else the project's); outside them the message waits for the next run of the dispatcher.
- **What it costs.** _Send now_ first shows the recipients, the message segments (160 characters, 70 with an accent outside the GSM set; 153 and 67 when joined) and the estimated cost from `SMS_PRICE_PER_SEGMENT`. A wave to more than `SMS_CONFIRM_ABOVE` numbers (500 by default) is refused until it is confirmed a second time.
- **Opting out.** Every message ends with _Responda BAJA_ (_Reply STOP_). The provider hands replies to `POST /api/v1/webhooks/sms` (`{"from":"+51…","text":"BAJA"}`, header `x-webhook-secret: $SMS_WEBHOOK_SECRET`); a stop word (BAJA, STOP, CANCELAR, PARAR, UNSUBSCRIBE…) puts the number on the do-not-contact list, in every organisation that wrote to it, and the invitations still waiting for it are not sent.

Settings: `SMS_PROVIDER` (`console` logs, `file` writes JSON files to `SMS_OUTBOX_DIR`, `acs` sends through Azure Communication Services with `SMS_CONNECTION_STRING` and `SMS_FROM`, best as Key Vault references), `SMS_PRICE_PER_SEGMENT`, `SMS_CONFIRM_ABOVE`, `SMS_WEBHOOK_SECRET`.

Before the first real wave: confirm that Azure Communication Services can send to the countries of the fieldwork and which sender (number, short code or alphanumeric ID) each country accepts; register the sender where the operators require it; and read the telecom rules of those countries on consent and opt-out. The ACS adapter signs its REST call as the service documents and is tested against that description, but it has **not been run against a live resource**: send a few messages to your own numbers first. Delivery receipts are not read (ACS reports them through Event Grid): the invitation stays _sent_, and a number that does not exist shows up only as no answer.

### Interview recordings

Face-to-face (CAPI) interviews can be recorded for quality review (ADR 0001, decision 5). It is **off in every project** and nothing is recorded until a project turns it on in **Settings → Field work → Recording of interviews**.

**Before turning it on in a real project** the institution's legal area must agree the legal basis, the consent wording, the retention period and who may listen (the applicable personal-data law is for them to confirm). The application only makes it possible to do it carefully.

- **Consent first.** The server draws, by the interview's id, the share of interviews to record (`samplePercent`); for those, the device asks the respondent with the project's wording before anything is recorded. The answer is kept as paradata (`audio_consent`, with the version of the wording, which goes up whenever the text changes). A _no_, or stopping later with **Stop recording**, ends the recording; the server refuses segments unless the latest answer is a yes.
- **Capture.** Mono Opus in WebM (AAC in MP4 on Safari) at about 24 kbps, roughly 11 MB an hour, in files of 30 seconds that are each complete. They wait in the device's own IndexedDB (`ws-audio`) until the server takes them, so interviews with no connection lose nothing. Interviews started offline are drawn on the device with the same rule; the server checks it again on every upload.
- **Storage.** A private container `interview-audio` in the export storage account (or `DATA_DIR/audio` locally), written through the API and read through the API; no signed links, no public access. The files are `tenant/project/interview/segment`; the table `interview_audio` keeps size, duration and SHA-256 under row-level security.
- **Listening.** Only with the permission `audio.listen` (owners, administrators, supervisors and reviewers by default), in the review screen. The API streams the file with range support; each listening is written to the activity log (`audio.listened`), once per segment played from its start.
- **Life of the files.** Deleted by the nightly job `audio.retention` once the interview was approved or rejected more than `retentionDays` ago (90 by default; recorded as `audio.deleted`), by the erasure of a person's data (the recordings of their interviews go with it), and, as a backstop, by a Blob lifecycle rule in `infra/azure/main.bicep` after 3660 days.

Not done: recording only marked questions (short clips); sending flagged interviews to the audio queue first; recording web (CAWI) or telephone (CATI) interviews; reading what is said. The browser recorder was tested in its sending logic and against the server, not yet on a real tablet: try it on the devices of the fieldwork (microphone permission, battery, storage) before relying on it.

### Web notifications

People can ask to be told, in the browser, when something needs them (ADR 0001, decision 6): **account menu → Notifications on this device**. Nothing is asked of the browser until they tick a category.

- **Categories.** Callbacks about to be due (a look every minute at the next five; one notice per person and five-minute window), new cases assigned, one of their interviews returned, their export ready. The message is generic and ready-made on the server ("You have 2 callbacks due"); it holds no names or answers, and tapping it opens the app. A wave that has finished is not announced yet.
- **Setup.** `pnpm --filter @wansurvey/api vapid` prints a key pair; set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (a secret: a Key Vault reference in production) and `VAPID_SUBJECT` (`mailto:` or `https:` of whoever runs the service). All three or none; without them the menu entry does not appear and nothing is sent. Changing the keys invalidates the subscriptions made with the old public key: people subscribe again.
- **Delivery.** Notifications wait in the database (`push_outbox`, created in the transaction of the change that caused them, and only for people who subscribed to that category) and the dispatcher sends them within seconds, encrypted for the browser (RFC 8291) and signed with VAPID (RFC 8292), over `node:crypto` and `jose`: no push library. A push service that answers 5xx or 429 is tried again after 1, 5 and 30 minutes; a browser the service says is gone (404, 410) is forgotten. A person who is no longer an active member of the organisation is not sent anything. The endpoints are checked as webhook addresses are (https, no private network).
- **Limits.** There is no delivery guarantee: the browser or the device may be off, or the permission withdrawn. Where it works depends on the browser; on iOS only for the installed app (16.4 or later). Too many notifications make people turn them off, so the categories are few.

The k6 scripts that measured a CAWI burst of 50 completes per second and 300 interviewers syncing were removed with the PostgreSQL code (they are in the git history, before commit `3484e04`'s successor that removed `load/`). Measure again on a staging copy before large waves.
