# Running on Azure App Service (S1)

WanSurvey runs on Azure App Service with the Standard S1 plan, with Azure Database for PostgreSQL and Azure Cache for Redis. This is the setup for testing on Azure; production is planned on SQL Server (see the last section).

## Verdict

**Compatible.** Three things stopped it working on Azure and have been fixed (they were invisible on a local Postgres, where the owner is a superuser):

| Problem on Azure                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure Database for PostgreSQL has no superuser. The migrate script restated `NOSUPERUSER NOBYPASSRLS` on the application role, which only a superuser may write                                                                                                           | It creates the role with the defaults and then checks them (`apps/api/src/db/migrate.ts`)                                                                                                               |
| Tables used `FORCE ROW LEVEL SECURITY`, which also filters the owner. Without a superuser the owner runs the migrations, the seed and the security-definer functions (sign-in lookups, e-mail dispatch, nightly jobs, share links, respondent links), so they saw no rows | Migration `0019_owner_bypasses_rls.sql` turns FORCE off. Isolation is unchanged: the application connects as `wansurvey_app`, which owns nothing and is always filtered (checked by `test/rls.test.ts`) |
| App Service restarts a container that does not answer HTTP; the worker had no port                                                                                                                                                                                        | The worker answers `GET /health` on `WORKER_HEALTH_PORT`                                                                                                                                                |

Also added: the web container takes the API's address from `API_UPSTREAM`, and `TRUST_PROXY_HOPS` sets how many proxies sit in front of the API. CI runs the whole API test suite a second time against a database owned by an ordinary role, as on Azure (`apps/api/scripts/azure-like-db.sh`).

## Layout

One App Service plan **S1** (1 vCPU, 1.75 GB RAM per instance), Linux, with three Web Apps for Containers:

| App                                           | Image                                                        | Settings                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `wansurvey-web` (public, custom domain + TLS) | `apps/web/Dockerfile`                                        | `API_UPSTREAM=https://wansurvey-api.azurewebsites.net`, `WEBSITES_PORT=8080`                                                    |
| `wansurvey-api`                               | `apps/api/Dockerfile`                                        | `WEBSITES_PORT=3000`, health check path `/health`, `TRUST_PROXY_HOPS=3` (App Service front end → nginx → App Service front end) |
| `wansurvey-worker`                            | `apps/api/Dockerfile`, startup command `node dist/worker.js` | `WORKER_HEALTH_PORT=8080`, `WEBSITES_PORT=8080`, health check path `/health`, **Always On**                                     |

Turn **Always On** on for all three (S1 includes it), so the worker keeps running and the API answers the first request quickly.

Managed services:

| Service                                                     | Tier for testing      | Notes                                                                                                                                   |
| ----------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Azure Database for PostgreSQL – Flexible Server, version 16 | Burstable B1ms or B2s | `require_secure_transport` on; add `?sslmode=require` to both URLs. No extensions needed                                                |
| Azure Cache for Redis                                       | Standard C1           | TLS port 6380: `REDIS_URL=rediss://:<key>@<name>.redis.cache.windows.net:6380`. Set **maxmemory-policy = noeviction** (BullMQ needs it) |

Reach the database and Redis through VNet integration and private endpoints, or allow the App Service outbound addresses in their firewalls.

## App settings (API and worker)

```
DATABASE_URL=postgres://wansurvey_app:<password>@<server>.postgres.database.azure.com:5432/wansurvey?sslmode=require
DATABASE_ADMIN_URL=postgres://<admin>:<password>@<server>.postgres.database.azure.com:5432/wansurvey?sslmode=require
APP_ENCRYPTION_KEY=<32 bytes, base64 — from Key Vault: @Microsoft.KeyVault(SecretUri=...)>
REDIS_URL=rediss://:<key>@<name>.redis.cache.windows.net:6380
PUBLIC_WEB_URL=https://surveys.example.org
API_PUBLIC_URL=https://surveys.example.org
MAILER=smtp
SMTP_URL=smtps://<user>:<password>@smtp.example.org:465
MAIL_FROM=WanSurvey <encuestas@example.org>
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=512
```

`DATABASE_ADMIN_URL` is only needed where migrations run; leave it off the running apps if you can.

## First deployment

1. Create the database `wansurvey` on the Flexible Server.
2. Run the migrations once, from CI or your machine, with the API image:
   `docker run --rm -e DATABASE_ADMIN_URL=… -e DATABASE_URL=… <api-image> node dist/db/migrate.js`
   It creates the `wansurvey_app` role (password from `DATABASE_URL`) and checks it cannot bypass row-level security.
3. Optional demo data: `node dist/db/seed.js`, then `node dist/db/seed-demo.js` (needs `SEED_PASSWORD`, and `APP_ENCRYPTION_KEY` so the personal fields are sealed straight away).
4. Deploy the three apps; check `https://wansurvey-api…/health` and the worker's `/health`.

Before each later release, run step 2 with the new image, then swap deployment slots (S1 includes five).

## Capacity on S1

- **Memory**: the three apps share 1.75 GB per instance; together they use about 350 MB at rest (measured: API and worker about 165 MB each, nginx a few MB). Exports are built in memory (up to 100 MB of file), so large exports can briefly take several hundred MB more. `NODE_OPTIONS` caps each Node process; for heavy exporting, put the worker on its own plan.
- **CPU**: one vCPU per instance. For 300 interviewers syncing or a 50-per-second web survey burst, scale out to 2–3 instances (autoscale rule on CPU > 70%). Check the numbers with `load/` (k6) before a large wave.
- **Scale-out is safe**: sessions are in Postgres, exports in Postgres, and live dashboards are fanned out through Redis, so any instance can serve any request. Rate limits are kept per instance, so with N instances the effective limit is N times the setting.
- **Live dashboards**: Server-Sent Events work through App Service; the 15-second heartbeat stays well under the 230-second idle timeout, and nginx has buffering off for `/api/`.
- **Files**: nothing is written to local disk (exports are stored in the database), so the read-only, ephemeral container storage of App Service is fine.

## Moving to SQL Server later

The data layer is PostgreSQL-specific. Moving to Azure SQL / SQL Server means rewriting it, not changing a connection string:

| PostgreSQL feature used                                                       | SQL Server counterpart                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Row-level security policies on `app.tenant_id`                                | Security policies with a predicate function on `SESSION_CONTEXT(N'tenant_id')` |
| `jsonb` columns, `?`, `?                                                      | `, `jsonb_each`, `jsonb_object_agg`                                            | `nvarchar(max)` with `ISJSON`, `OPENJSON`, `JSON_VALUE`, `JSON_MODIFY` |
| `text[]` columns (modes, languages, PII index) and `= any(...)`               | Child tables or JSON arrays                                                    |
| Security-definer functions (sign-in, respondent links, nightly jobs, erasure) | Stored procedures with `EXECUTE AS OWNER`                                      |
| plpgsql triggers keeping history append-only                                  | T-SQL `INSTEAD OF UPDATE, DELETE` triggers                                     |
| GIN index on the PII word hashes                                              | A child table of hashes with a normal index                                    |
| `NULLS NOT DISTINCT` unique index                                             | A filtered unique index or a computed column                                   |
| `bytea` export files                                                          | `varbinary(max)` (or Blob Storage)                                             |
| `AT TIME ZONE '<IANA>'`                                                       | `AT TIME ZONE '<Windows name>'` (map IANA names)                               |
| `percentile_cont … within group`                                              | `PERCENTILE_CONT … WITHIN GROUP … OVER ()`                                     |
| Drizzle ORM (no stable SQL Server driver)                                     | Another data layer (e.g. Prisma or Kysely with `tedious`)                      |

Everything above the data layer (engine, renderer, web app, worker, Redis jobs) stays as it is.
