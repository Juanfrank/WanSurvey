# Load tests (k6)

Run on demand, not in CI (M8). Results and how to read them: [results.md](results.md).

## Data

On a migrated database (staging, or a local one), from `apps/api`:

```bash
DATABASE_ADMIN_URL=… APP_ENCRYPTION_KEY=… npx tsx scripts/load-setup.ts 300
```

This creates:

- an organisation;
- a three-question questionnaire with the open link `load-open`;
- 300 interviewers (password `load-password-123`), each with one case;
- `load/sync-users.json` for the sync test.

## Tests

```bash
cd load
# Web respondents: 50 completes a second for 2 minutes (open link, start, sync, submit).
k6 run -e BASE=https://staging.example.org cawi-burst.js
# Another rate or length; or a ramp from 10 to 150 a second to find the knee.
k6 run -e RATE=30 -e DURATION=2m cawi-burst.js
k6 run -e PROFILE=ramp cawi-burst.js
# 300 interviewers: everyone signs in within 30 s, then syncs every 10 s for 3 minutes.
k6 run -e BASE=https://staging.example.org sync-300.js
```

Each simulated respondent or tablet sends its own `X-Forwarded-For`. The API reads that header
behind the proxy (`TRUST_PROXY_HOPS=1`), so the limits per address apply to each simulated
person, as in the field. Without it, every request would come from one address and stop at
20 open-link starts a minute. Against a deployment whose proxy overwrites the header, spread
the load generators instead.

## Server-side measures

While a test runs:

```bash
API_PID=$(pgrep -f '^node dist/main.js') WORKER_PID=$(pgrep -f '^node dist/worker.js') \
  DATABASE_ADMIN_URL=… REDIS_DB=0 ./sample.sh samples.csv &
```

`sample.sh` records, once a second:

- CPU (% of one core) and memory of the API and the worker;
- Postgres connections;
- jobs waiting in the worker's queue;
- interviews submitted.

After the test:

```bash
python3 summarise.py samples.csv
```

This prints the mean and the peak of each measure, and how long the queue took to empty after
the load. On a single machine, pin each part to its own cores (`taskset`) so that k6 does not
take the API's CPU.

## Targets (spec §11)

- **Latency:** p95 under 800 ms for submissions and syncs.
- **Errors:** none.
- **Worker:** its queue empty within a minute after the burst.

Record each run in `results.md` with the deployment size and the date.
