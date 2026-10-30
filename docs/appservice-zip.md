# App Service from a zip (no containers, one instance)

The way to deploy where there is no Azure CLI and no containers: App Service on Linux runs a zip of
the built app on its own Node runtime. Everything runs in one Node process on one instance:

| What                | How                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| API and web app     | The API serves the built web app itself (`WEB_DIST`): caching, security headers and gzip as nginx did                          |
| Background jobs     | In the same process, no Redis: light jobs `JOB_CONCURRENCY` at a time, heavy ones (exports, scans) one at a time, 3 tries each |
| Scanned paper forms | Drawn with pdf.js on a native canvas inside the zip (no Poppler to install)                                                    |
| Migrations          | Applied when the app starts (`DATABASE_ADMIN_URL`), one process at a time                                                      |
| Export files        | Azure Blob Storage, through the app's managed identity                                                                         |

`infra/azure/main.bicep` (three containers with nginx and Redis) is kept as a reference for now; it
is not this deployment.

## 1. The zip

Every push builds it in CI (job **package**, on Linux x64 like App Service): download the artifact
`wansurvey-appservice-<commit>` from the run. Or build it on a Linux x64 machine:

```bash
scripts/package-appservice.sh out        # → out/wansurvey-appservice.zip (~70 MB)
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres \
  scripts/smoke-appservice.sh out/wansurvey-appservice.zip   # starts it as App Service would
```

It holds `dist/` (the API), `drizzle/` (migrations), `public/` (the web app), `package.json`
(`npm start`) and `node_modules/` with production dependencies only, as plain folders. Native
modules (Argon2, the canvas) are built for Linux x64 glibc: build it on Linux, not on Windows or a
Mac.

## 2. Azure resources (portal)

1. **Azure Database for PostgreSQL – Flexible Server** 16 (B1ms for testing, B2s for fieldwork):
   database `wansurvey`; connections only through the app's network (VNet integration and private
   endpoint) or its outbound addresses. The owner role goes in `DATABASE_ADMIN_URL`; the app's own
   role (`wansurvey_app`, made by the migrations) in `DATABASE_URL`.
2. **User-assigned managed identity** (`wansurvey-id`).
3. **Storage account** (StorageV2, LRS, minimum TLS 1.2, no public blob access, account key
   access off): container `exports`; on the account, role **Storage Blob Data Contributor** for
   the identity; lifecycle rule deleting blobs in `exports/` after 8 days.
4. **Key Vault** with the secrets (database URLs, encryption key, SMTP, Entra client secret);
   role **Key Vault Secrets User** for the identity.
5. **App Service plan** Linux **P0v3**, **1 instance** (no autoscale).
6. **Web App**: publish **Code**, runtime **Node 24 LTS**, Linux, on that plan. Then:
   - Identity → User assigned → add `wansurvey-id`; Key Vault reference identity: the same.
   - Configuration → General: **Always On** on, HTTP 2.0, minimum TLS 1.2, FTP off, startup
     command `npm start` (or empty: App Service runs `npm start` itself).
   - Health check: path `/health`, with `HEALTH_ALLOWED_IPS` set (see below).
   - Environment variables → **Advanced edit**: paste `appconfig/appservice.production.template.json`
     filled in (see [`docs/azure.md`](azure.md#settings-by-hand-no-bicep)).

## What each setting is

The templates in `appconfig/` hold these (copy one without `.template`, fill in the `<…>`).

**Two database connections, on purpose:**

| Setting              | Connects as                                                     | Used for                                                                                                                                            |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | `wansurvey_app`, a restricted role                              | Every request and job. Row-level security applies: it sees one organisation at a time, cannot change the schema, and cannot switch the security off |
| `DATABASE_ADMIN_URL` | The database's owner (on Azure, the admin made with the server) | Only the migrations at start (and seeding demo data). It also creates `wansurvey_app`, with the password written in `DATABASE_URL`                  |

Least privilege: if the app's connection leaked, it could still not read other organisations'
data or alter tables. Keep both in Key Vault. To keep the owner's password off the app, leave
`DATABASE_ADMIN_URL` out and run the migrations by hand from the SSH console
(`DATABASE_ADMIN_URL=… node dist/db/migrate.js`) before each release.

**One public address:** `PUBLIC_WEB_URL` is every link a person opens (invitations, password
reset, survey links, shared summaries) and the Microsoft redirect URI registered in Entra
(`ENTRA_REDIRECT_URI`, normally `{PUBLIC_WEB_URL}/api/v1/auth/sso/callback`). The API answers `/api` on that same address: from
the zip it serves the web app itself; in development Vite passes `/api` on to it.

**`/health` only for the platform:** `HEALTH_ALLOWED_IPS` lists the addresses that may call it,
single IPs and CIDR ranges separated by commas (`169.254.0.0/16,127.0.0.1,::1`). Anyone else gets
the 404 of a route that does not exist; empty lets everyone in. The address is the one the proxy
saw: App Service's front end adds the caller to `X-Forwarded-For` (with its port, which is
removed), so a client cannot pass as another by sending that header. A refused call is logged
(`health: address not in HEALTH_ALLOWED_IPS`, with the address).

- **Can the range include Azure's own check?** Not as a published range. Microsoft documents no
  source address for App Service's health check, and no service tag covers it; the check runs from
  inside the platform. What is seen in practice, not documented, is internal link-local
  addresses (`169.254.x.x`, the range that also shows as the caller in other platform requests),
  so `169.254.0.0/16` is the starting value; the platform could change it. Check it on your
  instance: set the list, look in **Log stream** for the refused address within a minute, and
  narrow the range to what appears. A wrong list takes the instance out of rotation (after
  `WEBSITE_HEALTHCHECK_MAXPINGFAILURES` failed pings) and, if it lasts an hour, App Service
  replaces it: set the list in a staging slot or while watching the log.
- Monitoring from outside (Application Insights availability, a load balancer) goes in the list by
  its own addresses, or uses another route.

**The rest:**

- `APP_ENCRYPTION_KEY`: seals personal data and secrets in the database; 32 random bytes in base64,
  one per environment, never changed once data exists.
- `NODE_ENV`: `production` turns on the production checks (Blob Storage required, HSTS).
- `PASSWORD_LOGIN`, `SSO_DEFAULT_ORG`, `ENTRA_*` (tenant, client, secret and `ENTRA_REDIRECT_URI`): sign-in (`docs/sso-entra.md`).
- `MAILER`, `SMTP_URL`, `MAIL_FROM`: e-mail; `console` writes it to the log instead.
- `EXPORT_STORAGE`, `EXPORT_BLOB_URL`, `AZURE_CLIENT_ID`: export files in Blob Storage, reached with
  the managed identity whose client id this is.
- `NODE_OPTIONS`, `DB_POOL_MAX`, `JOB_CONCURRENCY`, `HEAVY_JOB_CONCURRENCY`,
  `MAX_CONCURRENT_REQUESTS`: memory and concurrency of the one process.
- `WEB_DIST`, `TRUST_PROXY_HOPS=1`, `WEBSITE_RUN_FROM_PACKAGE=1`,
  `SCM_DO_BUILD_DURING_DEPLOYMENT=false`: how the zip runs (the web app's folder, App Service's
  front end as the one proxy, the zip mounted read-only, no rebuild by Oryx).

## 3. Deploy a version

1. Web App → **Advanced Tools (Kudu)** → Go → **Tools → Zip Push Deploy**; drop the zip on the
   file area. (Or Deployment Center, if it is connected to the repository's artifacts.)
2. With `WEBSITE_RUN_FROM_PACKAGE=1` the zip is mounted read-only as `/home/site/wwwroot` and the
   app restarts on it; `SCM_DO_BUILD_DURING_DEPLOYMENT=false` keeps App Service from rebuilding it.
3. On start the app applies pending migrations, then listens on `PORT`. A failed migration stops
   it: the health check keeps it out of rotation and the log stream says why.
4. Check `https://<app>/health`, sign in, and look at **Log stream** for errors.

## Limits of one process on one instance

- **CPU**: one vCPU for requests and jobs. Heavy jobs run one at a time and yield between pages, but
  a large export or a batch of scanned forms still takes CPU from requests while it runs.
- **A restart** (deploy, platform maintenance) drops jobs waiting in memory: the sweeper requeues
  exports and scanned batches every 5 minutes and the nightly recompute rebuilds the figures; e-mail
  dispatch picks up where it was.
- **Rate limits** are counted in memory: correct with one instance, and reset on restart.
- **No slots swap without care**: a staging slot is a second process on the same database; it may
  run, but do not start two production instances (scale-out needs Redis and the worker again).
