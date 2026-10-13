# Load tests (k6)

Run on demand against a staging deployment, not in CI (M8). Install [k6](https://k6.io), then:

```bash
# 50 web completes per second for 2 minutes. Needs a project with an open link (slug) whose
# questionnaire is short; each iteration opens the link, answers and submits.
k6 run -e BASE=https://staging.example.org -e SLUG=demo-open load/cawi-burst.js

# 300 interviewers syncing at once, every 10 seconds, for 3 minutes. USERS lists the accounts
# (password PASSWORD), each with an interview started on its device.
k6 run -e BASE=https://staging.example.org -e PASSWORD=… -e USERS=./sync-users.json load/sync-300.js
```

Open links are rate limited per address (20 starts a minute); raise the limit on staging, or
spread the load generators, before the burst test.

Targets (spec §11): p95 under 800 ms for submissions and syncs, no errors, the worker's
`stats.refresh` queue drained within a minute after the burst. Record each run's results in
`load/results.md` with the deployment size and the date.
