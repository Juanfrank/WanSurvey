# Load test results

## 2026-10-24 — local run, one API process pinned to one core (P0v3-like)

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

### To improve capacity (not done)

- The CPU cost per complete is mostly query building. Candidates:
  - prepared queries (`.prepare()` in Drizzle) on the respondent's hot path: start, sync, submit;
  - fewer transactions per complete (7.4).
- `localDay()` creates an `Intl.DateTimeFormat` on each submission; cache one per time zone.
