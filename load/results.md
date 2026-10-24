# Load test results

## 2026-10-24 (third run) — CPU of each step

One virtual user, so requests never overlap. N = 1,500 respondents per measure, each stopped
after a given step (`STEPS=1…4`). The API's CPU time is read from `/proc` before and after
each measure, and each measure was taken twice. The cost of a step is the difference between
consecutive measures.

| Step                                                      | API CPU per request | Share of a complete |
| --------------------------------------------------------- | ------------------- | ------------------- |
| Open link (`POST /public/o/:slug/start`)                  | 5.5 ms              | 21 %                |
| Start (`GET /public/s/:token`, returns the questionnaire) | 7.4 ms              | 28 %                |
| Sync (3 answers and the snapshot)                         | 5.4 ms              | 21 %                |
| Submit                                                    | 7.8 ms              | 30 %                |
| **Whole complete**                                        | **26.1 ms**         |                     |

**What a submit spends.** With the post-submit hooks turned off in the build, a submit cost
4.7 ms; the hooks are the review flags and the day's statistics. That leaves about **3 ms**
(±1.5 between measures) that could move to the worker.

**Where the rest goes.** Opening a link does almost nothing (one insert), yet costs 5.5 ms.
Most of each request's cost is therefore fixed, spent before and after the handler. That
fixed cost is an estimate, not a measure: about 3–4 ms a request, so over half of a complete.
It covers:

- Express and Nest;
- the throttler's two Redis counters;
- the request log;
- the security headers;
- JSON.

## 2026-10-24 (second run) — after the capacity changes

Same machine, settings and method as the run below; the code changed:

- **One transaction per respondent request.** The link's lookup and the context are set by
  the first statement (`Database.withTenantOf`), instead of a lookup and then `withTenant`.
- **Hot queries built once.** These are run directly on the transaction's connection
  (`Prepared`), where Postgres keeps them prepared:
  - the invitation and interview row locks;
  - the device's last change number, read and written;
  - the device row insert.
- **Fewer reads:**
  - `latestVersion` takes the compiled questionnaire from the in-process cache instead of
    fetching and decoding it on every open and start;
  - version numbers are cached;
  - the project is read once per respondent start;
  - `localDay()` keeps one date formatter per time zone.

|                                                 | Before                                         | After                                                                   |
| ----------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Transactions per web complete                   | 7.4                                            | **4.0**                                                                 |
| Statements per web complete (with the worker's) | 62                                             | 55                                                                      |
| Knee (ramp)                                     | ~34 completes/s                                | **~47 completes/s**                                                     |
| 50 completes/s for 2 min                        | 8.2 % shed (503), submit p95 431 ms            | **0 % errors**, submit p95 **126 ms**, sync p95 109 ms, 5,951 submitted |
| 30 completes/s for 2 min                        | submit p95 96 ms, sync p95 73 ms, API CPU 98 % | submit p95 **32 ms**, sync p95 **23 ms**, API CPU 87 %                  |
| 300 interviewers syncing                        | sync p95 35 ms, login p95 129 ms, API CPU 38 % | sync p95 30 ms, login p95 75 ms, API CPU 35 %                           |

**Ramp, after.**

| Offered (completes/s) | Requests/s | Completes/s done | 503    | p95 of answered requests |
| --------------------- | ---------- | ---------------- | ------ | ------------------------ |
| 10 → 25               | 70         | 17.5             | 0 %    | 30 ms                    |
| 25 → 50               | 150        | 37.4             | 0 %    | 106 ms                   |
| 50 → 75               | 215        | 47.4             | 6.4 %  | 297 ms                   |
| 75 → 100              | 256        | 47.3             | 15.7 % | 277 ms                   |
| 100 → 125             | 277        | 38.9             | 26.6 % | 319 ms                   |
| 125 → 150             | 303        | 32.7             | 34.5 % | 319 ms                   |

**Reading.**

- **The spec's target holds on one instance:** 50 web completes a second with no errors and
  p95 well under 800 ms. At that rate the instance has no headroom left (API CPU at the
  limit), so for a planned mass mailing starting with 2 instances is still the safe choice.
- **Past the knee:** load shedding behaves as before, and answered requests keep p95 near
  300 ms.

## 2026-10-24 (first run) — local run, one API process pinned to one core (P0v3-like)

**What ran.** Production build (`NODE_ENV=production`) of the API and the worker on an
Intel Xeon @ 2.80 GHz VM, Node 22.22, PostgreSQL 16.15 and Redis 7.0 on the same machine.

- **API:** pinned to one core (`taskset -c 0`). P0v3 has 1 vCPU, and Node serves requests on one thread.
- **Settings:** those of `infra/azure/main.bicep`: `DB_POOL_MAX=9`, `MAX_CONCURRENT_REQUESTS=50`, `TRUST_PROXY_HOPS=1`.
- **Worker:** on another core.
- **k6 v1.3.0 and the sampler (`sample.sh`):** on the remaining two cores.
- **Data:** from `apps/api/scripts/load-setup.ts`:
  - 300 interviewers with one case each;
  - an open link to a three-question questionnaire (AGE, SAT 1–5, COMMENTS);
  - by the end, 20,635 interviews in the database.

**Limits of this run.**

- **Database on the same machine:**
  - It is not a separate B1ms, and there is no network latency between the API and the database. In Azure, add about 1–2 ms per query; each web complete makes 7.4 transactions.
  - Postgres shared the machine's cores with k6.
- **No nginx in front:** behind the proxy, the API reads `X-Forwarded-For`, and each simulated respondent or tablet sends its own address. The per-address limits are therefore those of the field: 20 open-link starts and 120 survey requests a minute.
- **Session cookie sent by hand:** it is `Secure` in production, and the tests talk plain HTTP to the API.

### Results

| Test                                     | Load                                                                        | Requests/s | Errors                           | p95 (main step)                    | p99            | API CPU (one core)                     | Result                      |
| ---------------------------------------- | --------------------------------------------------------------------------- | ---------- | -------------------------------- | ---------------------------------- | -------------- | -------------------------------------- | --------------------------- |
| Interviewer sync (`sync-300.js`)         | 300 interviewers, everyone signed in within 30 s, a batch every 10 s ± 20 % | 30         | 0 %                              | sync **35 ms**, login 129 ms       | sync 60 ms     | mean 38 %, peak 103 % while signing in | ✅                          |
| Web, steady (`cawi-burst.js`, `RATE=30`) | 30 completes/s for 2 min (open, start, sync, submit)                        | 120        | 0 %                              | submit **96 ms**, sync 73 ms       | submit 289 ms  | mean 98 %                              | ✅                          |
| Mixed                                    | the 300 interviewers + 20 completes/s, for 3 min                            | ~110       | 0 %                              | sync (tablets) 55 ms, submit 45 ms | 111 ms / 76 ms | mean 83 %                              | ✅                          |
| Web burst (spec target, `RATE=50`)       | 50 completes/s for 2 min                                                    | 167        | **8.2 %**, all 503 load shedding | submit 431 ms, sync 410 ms         | 525 ms         | 115 % (saturated)                      | ❌ on one instance          |
| Ramp (`PROFILE=ramp`)                    | 10 → 150 completes/s over 3 min                                             | up to 282  | 0 % → 39 % (503)                 | 29 ms → ~400 ms                    | —              | saturated from ~35/s                   | knee at **~34 completes/s** |

**Ramp, by 30-second stage.**

| Offered (completes/s) | Requests/s | Completes/s done | 503    | p95 of answered requests |
| --------------------- | ---------- | ---------------- | ------ | ------------------------ |
| 10 → 25               | 70         | 17.5             | 0 %    | 29 ms                    |
| 25 → 50               | 141        | 33.6             | 1.7 %  | 361 ms                   |
| 50 → 75               | 183        | 34.2             | 15.5 % | 428 ms                   |
| 75 → 100              | 215        | 30.3             | 26.7 % | 411 ms                   |
| 100 → 125             | 248        | 28.2             | 34.1 % | 393 ms                   |
| 125 → 150             | 282        | 26.7             | 39.1 % | 394 ms                   |

**Server side** (from `sample.sh`, during the load).

- **API memory:** 345–382 MB. That leaves room in a 4 GB instance for the worker (~150 MB) and nginx.
- **Database connections:**
  - The API used 9–10, its pool plus the health probe.
  - At most 8 were active at once, even when saturated. CPU, not the database, is the limit.
- **Worker queue:** at most 2 delayed jobs (the day's statistics, grouped every 5 s), emptied **within 1 s** of the load stopping. Spec target: within a minute.
- **Worker CPU:** under 2 % on average, with an 18 % peak.

**Where the CPU goes** (30-second `--cpu-prof` at 30 completes/s).

| Share          | What                                                |
| -------------- | --------------------------------------------------- |
| 17 %           | idle                                                |
| 16 %           | building queries in Drizzle (`entity.is`, `sql.js`) |
| 8.5 %          | the postgres driver                                 |
| 7 %            | socket writes                                       |
| 6 %            | garbage collection                                  |
| under 2 % each | Express/Nest routing, zod validation                |

Each web complete costs:

- about 29 ms of CPU on the API;
- 7.4 transactions;
- 12.5 rows written;
- ~940 rows read, most of them by the worker recomputing the day's statistics. That recompute grows with the day's volume, but it runs at most once every 5 s per project and day.

### Reading

- **Interviewers:** 300 tablets syncing every 10 s use under 40 % of one instance, with p95 latencies far under the 800 ms target. One P0v3 holds several times that.
- **Web respondents:** one instance sustains about **34 completes a second**, about 120,000 an hour. The spec's 50 a second needs two instances.
- **Past the knee:** load shedding does its job. It answers 503 at once (with Retry-After), and requests it accepts keep a p95 of ~400 ms. Throughput drops only a little (34 → 27/s), with no timeouts and no errors other than 503. The app retries syncs with backoff; a respondent who is refused at the first step (opening the link) just tries again.
- **Autoscale is not enough for a sudden burst:**
  - It adds the second instance at CPU above 70 % (`main.bicep`), but only after a few minutes.
  - For a planned launch (a mailing to the whole sample), start with 2 instances, or stagger the mailing.
  - Two instances fit the B1ms's connections. In this run each instance held 10 connections: pool 9 plus the health probe.

### To improve capacity (done in the second run, above)

- The CPU cost per complete is mostly query building. Candidates:
  - prepared queries (`.prepare()` in Drizzle) on the respondent's hot path: start, sync, submit;
  - fewer transactions per complete (7.4).
- `localDay()` creates an `Intl.DateTimeFormat` on each submission; cache one per time zone.
