# Load tests (k6)

Scenarios for the three ways people reach the API, run on demand (not in CI):

| File      | Who                                 | What it does                                                                                          |
| --------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `cawi.js` | Web respondents                     | Open link, start, send the answers, submit; a constant rate (50 a second) or a ramp (`PROFILE=ramp`). |
| `cati.js` | Telephone interviewers              | Sign in once; next case, "dial", outcome. Half answer: interview started, synced and submitted.       |
| `capi.js` | Face-to-face interviewers (tablets) | Sign in once, download the cases (checkout); interviews created by the sync, synced again, submitted. |

`flows.js` holds the bodies of the requests. They are played against the real API by
`apps/api/test/mssql/load-flows-http.test.ts`, so a change in the API that would break these
scenarios breaks that test first.

## 1. A database

A development database with the migrations applied (`pnpm --filter @wansurvey/api db:migrate`),
or a staging copy. **Never production**: the setup adds an organisation and accounts.

## 2. Data

From the repository root, with the owner connection string of the database:

```bash
DATABASE_ADMIN_URL='mssql://sa:…@localhost:1433/wansurvey?trustServerCertificate=true' \
  pnpm --filter @wansurvey/api db:load-setup
```

It creates an organisation with one project (CATI, CAPI and CAWI), a three-question
questionnaire, the open link `load-open`, 50 telephone interviewers with 200 cases each (all with
a phone number) and 150 face-to-face interviewers with 10 cases each, and writes `load/users.json`
(git-ignored). Ordinary accounts, password `load-password-123`: nothing is turned off. Change the
amounts with `LOAD_CATI_USERS`, `LOAD_CAPI_USERS`, `LOAD_CATI_CASES`, `LOAD_CAPI_CASES`,
`LOAD_PASSWORD` and `LOAD_SLUG`. Every run adds a new organisation.

## 3. The API under test

Start it as for development (or point `BASE` at staging). Three settings matter for a test whose
virtual users all come from one machine:

- `RATE_LIMIT_PER_IP`: raise it (the default is 5000 a minute). Each simulated person sends their
  own `X-Forwarded-For`, which the API reads with `TRUST_PROXY_HOPS=1` (the default), so the limits
  per address apply to each of them, as in the field. If the deployment's proxy overwrites that
  header, spread the load generators instead.
- `LOGIN_RATE_LIMIT`: per address too; the default (10 a minute) is enough with the header above.
- `MAX_CONCURRENT_REQUESTS`: leave it at 200 to see load shedding (503 with `Retry-After`) or set
  `0` to measure the database alone.

Jobs (e-mail, dashboards, exports) need the worker, or run in the API process without Redis.

## 4. Run

```bash
cd load
k6 run -e BASE=http://localhost:3000 cati.js          # 50 phones, 30 s ramp, 3 minutes
k6 run -e BASE=http://localhost:3000 capi.js          # 150 tablets
k6 run -e BASE=http://localhost:3000 cawi.js          # 50 completes a second for 2 minutes
k6 run -e PROFILE=ramp cawi.js                         # 10 → 150 a second, to find the knee
k6 run -e VUS=20 -e DURATION=1m cati.js                # fewer people, shorter
k6 run -e DEBUG=1 cati.js                              # print the body of a failed request
```

All three at once (a field day in every mode) are three terminals, or three `k6 run` in the
background; the totals then add up on the database.

`users.json` is read from this folder; `-e USERS=path` points to another. A CATI virtual user stops
when its 200 cases are gone (`cati_queue_empty` counts the empty answers); a tablet stops when its
10 cases are done. Make more with `LOAD_CATI_CASES` / `LOAD_CAPI_CASES` for longer runs.

## Reading the result

Targets (spec §11): p95 under 800 ms for `next`, `outcome`, `sync` and `submit`; sign-in under
2 s; failed requests under 1 %. A threshold that fails makes k6 exit with an error. Also look at:

- **503** answers: load shedding at `MAX_CONCURRENT_REQUESTS`. Normal beyond the limit, a sign of
  too little capacity below it.
- **Database**: connections in use against `DB_POOL_MAX` and `DB_WORKER_POOL_MAX`, and waits
  (`sys.dm_exec_requests`); the CATI queue and the CAPI sync are the heavy writers.
- **Worker**: jobs waiting after the test (statistics and BI refresh); the queue should be empty
  within a minute.

Record each run (date, size of the deployment, numbers) where the team keeps its results.
