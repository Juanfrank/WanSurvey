# Load test results

## 2026-10-24 (fifth run) — proposals 1, 2 and 3 implemented

The code now has:

- shedding by priority;
- every query of the four respondent requests built once (`Prepared`, with hand-written SQL
  for the joined reads);
- 19 statements per web complete instead of 33.

Same machine and method as the earlier runs.

|                                          | Before (second run)                                 | After                                                                          |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Statements per web complete              | 33                                                  | **19** (open 3, start 6, sync 5, submit 5)                                     |
| API CPU per complete (sequential)        | 22.6–26.1 ms                                        | **20.8 ms**                                                                    |
| Knee (ramp)                              | ~47 completes/s                                     | **~72 completes/s**                                                            |
| Ramp at 125–150 offered a second         | 33–39 completes/s, 26–35 % 503s, served p95 ~320 ms | **70–74 completes/s**, 12–19 % 503s, served p95 **~140 ms**                    |
| 503s on interviews under way, whole ramp | 2,414 (before priority)                             | **0**: all 3,664 503s were link openings                                       |
| 50 completes/s for 2 min                 | 0 % errors, submit p95 126 ms, sync p95 109 ms      | 0 % errors, submit p95 **25 ms**, sync p95 **25 ms**, queue drained within 2 s |
| 300 interviewers syncing                 | sync p95 30 ms, login p95 75 ms                     | sync p95 31 ms, login p95 295 ms (under the 2 s target)                        |

**Reading.**

- **Throughput rose more than the CPU per complete fell (+53 % against −10 %).** The profile
  explains it: under concurrency, each statement removed is also one less wait on its
  connection and its row locks. With fewer and shorter transactions, the pool of 9 connections
  serves more requests a second.
- **One P0v3 instance now carries the spec's 50 web completes a second with room to spare.**
  Past its limit it keeps about 70 a second, and only new link openings are refused.
- **Login p95 rose (75 → 295 ms) while 300 people signed in within 30 s.**
  - It is argon2, deliberately expensive, sharing the core; the sync itself did not change.
  - It is far under the target, but it is the place to look if sign-in at the start of a
    field day matters.

## 2026-10-24 (fourth run) — experiments behind each proposal

Same setup as the earlier runs. Each proposal was tried as a variant of the build and measured
against the current code:

- **CPU per request:** one virtual user, 1,500–3,000 requests per measure, each measure taken
  twice.
- **Behaviour under overload:** the ramp from 10 to 150 completes a second.

| Proposal tried                                                                                                                                | Measure                                                            | Result                                                                                                                        | Decision                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Fixed cost per request                                                                                                                        | A request through the whole pipeline that ends before the database | **1.3 ms** (not 3–4 ms as estimated earlier)                                                                                  | Only about 20 % of a complete is fixed cost                                       |
| One rate-limit counter instead of two on public routes                                                                                        | Per complete                                                       | −0.1 ms, within the noise                                                                                                     | Rejected                                                                          |
| No rate limiting at all (the ceiling of any change there)                                                                                     | Per request                                                        | −0.4 ms                                                                                                                       | Rejected: not worth weakening the limits                                          |
| No automatic request log                                                                                                                      | Per complete                                                       | No measurable change                                                                                                          | Rejected                                                                          |
| Load shedding before the body parsers                                                                                                         | Ramp                                                               | Same completes per second and the same 503s                                                                                   | Rejected                                                                          |
| Shedding by priority: new link openings turned away first (at 60 % of the limit), steps of interviews under way allowed up to twice the limit | Ramp, 75 → 150 offered a second                                    | **51 completes/s instead of 37**; served p95 **190 ms instead of 290 ms**; **0** 503s on start, sync or submit (2,414 before) | **Do**                                                                            |
| Submit hooks (review flags, the day's statistics) to the worker                                                                               | Per submit                                                         | −3 ms on the API (±1.5)                                                                                                       | Not now: the worker shares the instance's vCPU, so it only moves the work in time |
| Realistic questionnaire (household sample, 46 KB compiled instead of 3 KB)                                                                    | Start                                                              | +0.5 ms                                                                                                                       | Nothing to do: the compiled-form cache works                                      |
| Cost of a statement                                                                                                                           | Three extra `select 1` when opening a link                         | +0.1 ms each                                                                                                                  | A round trip is cheap; building queries and moving rows is what costs             |

**CPU profile of a whole complete** (22.6 ms of API CPU, sequential). Self time by package:

| Share          | ms  | What                                                                           |
| -------------- | --- | ------------------------------------------------------------------------------ |
| 15.9 %         | 3.6 | Drizzle building queries (`entity.is`, `sql.js`, `buildQueryFromSourceParams`) |
| 11.2 %         | 2.5 | the postgres driver                                                            |
| 10.3 %         | 2.3 | socket writes to Postgres (`writeBuffer` from the driver)                      |
| 8.6 %          | 2.0 | garbage collection                                                             |
| 1.3 %          | 0.3 | Redis, plus 0.4 ms writing to it                                               |
| under 3 % each |     | router, Express, Nest, zod, pino-http                                          |

**Proposals, in order.** "Measured" means tested as a variant above; "estimated" is worked out
from the profile.

1. **Shedding by priority** (measured).
   - Under overload: 37 → 51 completes/s, served p95 290 → 190 ms, and no 503 on interviews
     already under way.
   - A change in one middleware, with a test.
2. **Build every query of the four respondent requests once** (`Prepared`, estimated).
   - Saves most of Drizzle's 3.6 ms, about 2–2.5 ms per complete.
   - Today only the locks and the device's change number use it.
3. **Fewer statements per complete, from 33 to about 23** (estimated, about 2 ms). Each
   statement removed saves its share of the driver, the socket writes and Drizzle:
   - open and start: the questionnaire's state with its version in one query, and the two
     invitation updates in one;
   - start: the device row inserted with `returning last_seq` instead of read afterwards;
   - sync and submit: the interview locked together with the device's last change number;
     the interview and the device updated in one statement;
   - submit: the two review counts in one query, and the flags written in the same update as
     the status;
   - start and submit: the project's settings and time zone read once.
4. **Together (2 and 3), estimated:** about 4 ms less per complete (around 18 %), a knee near
   **55–57 completes/s** on one instance. Measure with the ramp after each step.
5. **Not now:**
   - **Submit queue:** 3 ms, but on the same vCPU;
   - **Rate limits:** combining or removing them gains at most 0.4 ms;
   - **Logging and parsers:** no gain.

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
