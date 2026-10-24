/* global __ENV, __VU, __ITER */
// CAWI burst (spec §11): 50 completed web interviews per second. PROFILE=ramp instead raises
// the rate step by step (10 → 150 a second) to find where the deployment stops keeping up.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE ?? 'http://localhost:3000';
const SLUG = __ENV.SLUG ?? 'load-open';
const RATE = Number(__ENV.RATE ?? 50);
// How far each respondent goes: 1 open, 2 start, 3 sync, 4 submit (to measure each step).
const STEPS = Number(__ENV.STEPS ?? 4);

const scenarios = {
  burst: {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: __ENV.DURATION ?? '2m',
    preAllocatedVUs: 200,
    maxVUs: 600,
  },
  ramp: {
    executor: 'ramping-arrival-rate',
    startRate: 10,
    timeUnit: '1s',
    preAllocatedVUs: 300,
    maxVUs: 1500,
    stages: [
      { target: 25, duration: '30s' },
      { target: 50, duration: '30s' },
      { target: 75, duration: '30s' },
      { target: 100, duration: '30s' },
      { target: 125, duration: '30s' },
      { target: 150, duration: '30s' },
    ],
  },
};

export const options = {
  scenarios: { [__ENV.PROFILE ?? 'burst']: scenarios[__ENV.PROFILE ?? 'burst'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{step:submit}': ['p(95)<800'],
    'http_req_duration{step:sync}': ['p(95)<800'],
    completes_failed: ['count<1'],
  },
};

const completeTime = new Trend('complete_duration', true);
const completesFailed = new Counter('completes_failed');

// Respondents come from many addresses; behind the proxy (TRUST_PROXY_HOPS=1) the API reads
// X-Forwarded-For, so each simulated respondent gets its own and the per-address limits
// (20 open-link starts and 120 survey requests a minute) apply to each, as in the field.
const headersFor = (ip) => ({
  'content-type': 'application/json',
  'x-forwarded-for': ip,
});

export default function () {
  const n = __VU * 100000 + __ITER;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const headers = headersFor(ip);
  const t0 = Date.now();
  // An open link gives a fresh respondent token.
  const open = http.post(`${BASE}/api/v1/public/o/${SLUG}/start`, '{}', {
    headers,
    tags: { step: 'open' },
  });
  if (!check(open, { opened: (r) => r.status === 200 })) return completesFailed.add(1);
  if (STEPS < 2) return;
  const token = open.json('token');
  const device = `k6-browser-${__VU}-${__ITER}`;
  const start = http.get(`${BASE}/api/v1/public/s/${token}?device=${device}`, {
    headers,
    tags: { step: 'start' },
  });
  if (!check(start, { started: (r) => r.status === 200 })) return completesFailed.add(1);
  if (STEPS < 3) return;
  // The load questionnaire (apps/api/scripts/load-setup.ts): AGE, SAT 1–5, COMMENTS.
  const now = new Date().toISOString();
  const answer = (seq, variable, value) => ({
    seq,
    kind: 'answer',
    variable,
    oldValue: null,
    newValue: value,
    at: now,
    source: 'respondent',
  });
  const ops = [
    answer(1, 'AGE', 30 + (__ITER % 50)),
    answer(2, 'SAT', 1 + (__ITER % 5)),
    answer(3, 'COMMENTS', 'Prueba de carga'),
  ];
  const sync = http.post(
    `${BASE}/api/v1/public/s/${token}/sync`,
    // With the engine snapshot after the last change, as the browser sends it: the end reached.
    JSON.stringify({
      deviceId: device,
      ops,
      state: {
        answers: { AGE: ops[0].newValue, SAT: ops[1].newValue, COMMENTS: ops[2].newValue },
        stash: {},
        confirmations: {},
        visited: ['AGE', 'SAT', 'COMMENTS'],
        prefilled: [],
        position: 'COMMENTS',
        completed: true,
        language: 'es',
      },
      position: 'COMMENTS',
      activeMs: 20000,
      totalMs: 25000,
    }),
    { headers, tags: { step: 'sync' } },
  );
  if (!check(sync, { synced: (r) => r.status === 200 })) return completesFailed.add(1);
  if (STEPS < 4) return;
  const submit = http.post(
    `${BASE}/api/v1/public/s/${token}/submit`,
    JSON.stringify({ deviceId: device, seq: 3, path: ['AGE', 'SAT', 'COMMENTS'] }),
    { headers, tags: { step: 'submit' } },
  );
  if (!check(submit, { submitted: (r) => r.status === 200 })) return completesFailed.add(1);
  completeTime.add(Date.now() - t0);
}
