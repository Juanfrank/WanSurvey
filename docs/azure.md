# Running on Azure App Service (Premium v3 P0v3, one app)

> **Deploying without the Azure CLI or containers?** Use [`docs/appservice-zip.md`](appservice-zip.md): one Node process from a zip, one instance, no Redis. What follows (and `infra/azure/main.bicep`) is the container layout, kept as a reference for now.

WanSurvey runs on **one** Azure App Service: a Linux plan **Premium v3 P0v3** with a single Web App holding its three containers as sidecars (web, API, worker), next to Azure SQL Database (or a SQL Server) and Azure Cache for Redis. `infra/azure/main.bicep` creates the plan, the app, its containers, the identity that pulls the images and the autoscale rule.

## Verdict

**Compatible.** The database is SQL Server (Azure SQL Database or a SQL Server): the application connects as `wansurvey_app`, a contained database user that owns nothing and is always under the security policy, so isolation by organisation is the same on Azure SQL as in the tests (job `sqlserver`). The owner (migrations, seed, nightly jobs) runs through the `DATABASE_ADMIN_URL` connection.

Also: the web container takes the API's address from `API_UPSTREAM`, `TRUST_PROXY_HOPS` sets how many proxies sit in front of the API, and the worker answers `GET /health` on `WORKER_HEALTH_PORT` (App Service restarts a container that does not answer HTTP).

## Layout

One plan **P0v3** (1 vCPU, 4 GB of memory, 250 GB of storage per instance), Linux, with **one Web App** (`LinuxFxVersion=SITECONTAINERS`) and three containers. They share the network (they talk over `localhost`) and the app settings; only the main container is reached from outside, and only on 80 or 8080.

| Container          | Image                                        | Port | Role                                                                                           |
| ------------------ | -------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| `web` (main)       | `apps/web/Dockerfile`                        | 8080 | nginx: the app, `/api` and `/health` proxied to `API_UPSTREAM=http://localhost:3000`           |
| `api` (sidecar)    | `apps/api/Dockerfile`                        | 3000 | The API (`PORT` set from `API_PORT`, so a `PORT` given to the main container never reaches it) |
| `worker` (sidecar) | `apps/api/Dockerfile`, `node dist/worker.js` | 3001 | Background jobs and schedules; answers `/health` on `WORKER_HEALTH_PORT`                       |

The app's health check path is `/health`: nginx passes it to the API, which checks the database, so one probe covers the three layers. **Always On** is on. Sidecar apps ignore `WEBSITES_PORT` and the registry settings (`DOCKER_REGISTRY_*`): the port and the image are each container's own, and the images are pulled with a user-assigned identity holding AcrPull.

Deploy with:

```
az deployment group create -g <group> -f infra/azure/main.bicep \
  -p name=wansurvey acrName=<registry> imageTag=<tag> publicUrl=https://encuestas.example.org \
     databaseUrl='@Microsoft.KeyVault(SecretUri=…)' redisUrl='@Microsoft.KeyVault(SecretUri=…)' \
     encryptionKey='@Microsoft.KeyVault(SecretUri=…)' smtpUrl=… mailFrom='WanSurvey <encuestas@example.org>' \
     passwordLogin=false ssoDefaultOrg=<slug> entraTenantId=<directory id> entraClientId=<client id> \
     entraClientSecret='@Microsoft.KeyVault(SecretUri=…)' entraAllowedDomains=agency.org
```

`passwordLogin=false` makes sign-in the Microsoft button alone (`docs/sso-entra.md`, section 4). It defaults to `true`, so redeploying an environment that uses passwords keeps them. With `false`, the API refuses to start unless `ssoDefaultOrg` and the four `entra*` values are all set (an empty one counts as missing). With passwords kept, `entraEnforce=true` (default `false`) requires Microsoft in `ssoDefaultOrg` for everyone but its owners.

The three separate apps of the earlier setup (web, API and worker each on its own Web App) still work: set `API_UPSTREAM` to the API app's address and `TRUST_PROXY_HOPS=3`. Docker Compose on App Service retires on 31 March 2027; sidecars are its replacement, so the single app is the layout to keep.

Managed services:

| Service                                 | Size                                                                  | Notes                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Azure SQL Database (or SQL Server 2022) | A small vCore or DTU tier for testing; size for fieldwork by the load | Encryption on (the default); leave `trustServerCertificate` out of both URLs. Contained users need no server login. Check the tier's concurrent worker and session limits against the pool sizes below                         |
| Azure Cache for Redis                   | Standard C1                                                           | TLS port 6380: `REDIS_URL=rediss://:<key>@<name>.redis.cache.windows.net:6380`. Set **maxmemory-policy = noeviction** (BullMQ needs it)                                                                                        |
| Azure Storage (StorageV2, Standard LRS) | Pay per use                                                           | Export files, container `exports`. Made by `main.bicep`: no account keys, no public blobs, reached with the app's identity (Storage Blob Data Contributor); files deleted after 7 days by the app, after 8 by a lifecycle rule |

Reach the database, Redis and the storage account through VNet integration and **private endpoints**: they carry no SNAT limit (App Service gives each instance 128 SNAT ports to the internet, and asks for under 100 outbound connections per remote address and port), and the pools below keep the connections few and long-lived anyway.

## App settings

`infra/azure/main.bicep` sets these; every container sees all of them.

```
NODE_ENV=production
DATABASE_URL=mssql://wansurvey_app:<password>@<server>.database.windows.net:1433/wansurvey
APP_ENCRYPTION_KEY=<32 bytes, base64 — from Key Vault: @Microsoft.KeyVault(SecretUri=...)>
REDIS_URL=rediss://:<key>@<name>.redis.cache.windows.net:6380
PUBLIC_WEB_URL=https://encuestas.example.org
MAILER=smtp
SMTP_URL=smtps://<user>:<password>@smtp.example.org:465
MAIL_FROM=WanSurvey <encuestas@example.org>
EXPORT_STORAGE=blob                # export files in Blob Storage
EXPORT_BLOB_URL=https://<account>.blob.core.windows.net/exports
AZURE_CLIENT_ID=<the user-assigned identity's client id>
PASSWORD_LOGIN=false               # the Microsoft button only
SSO_DEFAULT_ORG=<slug>             # with ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET
ENTRA_ALLOWED_DOMAINS=agency.org   # (secret from Key Vault)
API_UPSTREAM=http://localhost:3000
TRUST_PROXY_HOPS=2                 # App Service front end → nginx → API
API_PORT=3000                      # the api container's PORT
WORKER_HEALTH_PORT=3001
API_NODE_OPTIONS=--max-old-space-size=1024      # the api container's NODE_OPTIONS
WORKER_NODE_OPTIONS=--max-old-space-size=1280   # the worker container's NODE_OPTIONS
DB_POOL_MAX=9
DB_WORKER_POOL_MAX=5
JOB_CONCURRENCY=4
HEAVY_JOB_CONCURRENCY=1
MAX_CONCURRENT_REQUESTS=50
WEBSITE_HEALTHCHECK_MAXPINGFAILURES=5
```

`DATABASE_ADMIN_URL` is only needed where migrations run; keep it off the app.

### Settings by hand (no Bicep)

`appconfig/` has the settings ready for App Service's **Environment variables → Advanced edit**, which takes JSON:

| Template                                         | For                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `appconfig/appservice.development.template.json` | A development app: passwords and Microsoft, e-mail to the log, smaller pools and heaps           |
| `appconfig/appservice.production.template.json`  | Production: the same settings `main.bicep` sets (Microsoft only, SMTP, Blob Storage, P0v3 sizes) |

1. Copy the template without `.template` (`appservice.production.json`): git ignores everything in `appconfig/` but the templates, so the filled copy never reaches the repository.
2. Replace every `<…>` value. Secrets are best as Key Vault references (`@Microsoft.KeyVault(SecretUri=…)`).
3. Paste the whole array into Advanced edit and save (the app restarts).

Microsoft sign-in takes all of `SSO_DEFAULT_ORG`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` and `ENTRA_REDIRECT_URI` or none (the API refuses to start otherwise); in development, delete those entries to go without. A test (`apps/api/test/appservice-settings.test.ts`) checks that each template, filled in, starts the app, and that it holds the zip's settings and none of the containers'.

## First deployment

1. Create the database `wansurvey` on the Azure SQL server, and the registry, Redis and Key Vault secrets.
2. Build and push the two images (`wansurvey-web`, `wansurvey-api`) with the same tag.
3. Run the migrations once, from CI or your machine, with the API image:
   `docker run --rm -e DATABASE_ADMIN_URL=… -e DATABASE_URL=… <api-image> node dist/db/mssql/migrate.js`
   It creates the contained user `wansurvey_app` (password from `DATABASE_URL`) and applies the T-SQL migrations.
4. Optional demo data: `node dist/db/seed.js`, then `node dist/db/seed-demo.js` (needs `SEED_PASSWORD`, and `APP_ENCRYPTION_KEY` so the personal fields are sealed straight away).
5. Deploy `infra/azure/main.bicep`; check `https://<app>/health`.

Before each later release, run step 3 with the new images, then deploy the new tag to a staging slot and swap (Premium v3 includes 20 slots).

## Capacity on P0v3

What changed from S1 (1 core, 1.75 GB, three apps) to P0v3 (1 vCPU on newer hardware, 4 GB, one app):

| Limit                              | S1, three apps                  | P0v3, one app                                                                                           | Why                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory per instance                | 1.75 GB shared by three apps    | 4 GB shared by three containers                                                                         | Plan size                                                                                                                                                                                          |
| Node heap (`--max-old-space-size`) | 512 MB each                     | API 1024 MB, worker 1280 MB                                                                             | About 2.3 GB of heap at most, ~3 GB with Node's memory outside the heap; the rest (≈1 GB) for the platform, nginx and `pdftoppm` while scans are read. At rest the three use about 350 MB together |
| Exports                            | Large ones could exhaust 512 MB | Any size up to `EXPORT_MAX_BYTES` (2 GB), in about 40 MB of worker memory over its base                 | Read 500 interviews at a time and written to Blob Storage as they are built, in 4 MB blocks                                                                                                        |
| DB connections per instance        | 15 (10 API + 5 worker)          | 16 (9 API + 5 worker + 1 health probe each)                                                             | One vCPU gains nothing from more; check the tier's limits for concurrent sessions and workers before adding instances                                                                              |
| Jobs at once                       | 4 light + 1 heavy               | 4 light + 1 heavy                                                                                       | Light jobs wait on the database and e-mail, not the CPU; one heavy job (export, scan reading) at a time keeps the API responsive on the one vCPU                                                   |
| Requests at once (load shedding)   | 200 per API                     | 50 per API                                                                                              | About 5 waiting per pooled connection; beyond that a fast 503 with Retry-After beats waiting into the front end's 230 s timeout                                                                    |
| Health check                       | Each app on its own `/health`   | One `/health` through nginx → API → database; out of rotation after 5 failed pings                      | App Service pings once a minute and, after an hour unhealthy, replaces the instance                                                                                                                |
| Scale-out                          | Manual or autoscale per app     | Autoscale on the plan: +1 above 70 % CPU for 10 min, −1 below 30 % for 20 min, up to `maxInstances` (2) | Each instance runs all three containers; the extra workers share the BullMQ queues and the schedules stay single (they are upserted by name)                                                       |
| Deployment slots                   | 5                               | 20                                                                                                      | Plan tier                                                                                                                                                                                          |

- **CPU**: one vCPU per instance, shared by the API, the worker and nginx. For 300 interviewers syncing or a 50-per-second web survey burst, allow 2–3 instances (raise `maxInstances`, and the database tier), or move to P1v3 (2 vCPU, 8 GB) and double `DB_POOL_MAX`. Measure with a load test (k6) on a staging copy before a large wave.
- **Concurrency settings** (pool sizes, timeouts, rate limits, job concurrency): see [`docs/concurrency.md`](concurrency.md), including how to size pools against the database's connection limits.
- **Scale-out is safe**: sessions are in the database, export files in Blob Storage, and live dashboards are fanned out through Redis, so any instance can serve any request. Rate limits are counted in Redis, so they hold across instances.
- **Live dashboards**: Server-Sent Events work through App Service; the 15-second heartbeat stays well under the 230-second idle timeout, and nginx has buffering off for `/api/`.
- **Files**: nothing is written to local disk (export files go to Blob Storage, streamed both ways: the worker writes them as it builds them, the API passes downloads through without holding them), so the ephemeral container storage of App Service is fine. The API refuses to start in production without `EXPORT_STORAGE=blob`.
- **A worker that stops**: the health check goes through the API, so it does not see the worker. Watch the worker's log stream and its jobs (failed jobs are kept in Redis); a restart of the app restarts all three containers.

### Sources

- Microsoft, [App Service pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/linux/): P0v3 1 vCPU, 4 GB, 250 GB; P1v3 2 vCPU, 8 GB.
- Microsoft, [sidecars in App Service](https://learn.microsoft.com/azure/app-service/overview-sidecar) and [configuring them](https://learn.microsoft.com/azure/app-service/configure-sidecar): one main container and up to nine sidecars, shared network and environment, external traffic on 80 or 8080, `WEBSITES_PORT` ignored; [migrating from Docker Compose](https://learn.microsoft.com/azure/app-service/migrate-sidecar-multi-container-apps) (retires 31 March 2027).
- Microsoft, [`Microsoft.Web/sites/sitecontainers`](https://learn.microsoft.com/en-us/azure/templates/microsoft.web/sites/slots/sitecontainers): `isMain`, `targetPort`, `startUpCommand`, `environmentVariables`, `authType`.
- Microsoft, [health check](https://learn.microsoft.com/azure/app-service/monitor-instances-health-check): a ping a minute, `WEBSITE_HEALTHCHECK_MAXPINGFAILURES` 2–10, an instance unhealthy for an hour replaced.
- Microsoft, [intermittent outbound connection errors](https://learn.microsoft.com/azure/app-service/troubleshoot-intermittent-outbound-connection-errors): 128 SNAT ports per instance, under 100 connections per remote endpoint, private endpoints without the limit.
