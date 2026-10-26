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
   - Health check: path `/health`.
   - Environment variables → **Advanced edit**: paste `appconfig/appservice.production.template.json`
     filled in (see [`docs/azure.md`](azure.md#settings-by-hand-no-bicep)).

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
