/* global __ENV, __VU, __ITER */
// CAWI burst (spec §11): 50 completed web interviews per second.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE ?? 'http://localhost:3000';
const SLUG = __ENV.SLUG ?? 'demo-open';

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 200,
      maxVUs: 600,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{step:submit}': ['p(95)<800'],
    'http_req_duration{step:sync}': ['p(95)<800'],
  },
};

const json = { headers: { 'content-type': 'application/json' } };

export default function () {
  // An open link gives a fresh respondent token.
  const open = http.post(`${BASE}/api/v1/public/o/${SLUG}/start`, '{}', {
    ...json,
    tags: { step: 'open' },
  });
  if (!check(open, { opened: (r) => r.status === 200 })) return;
  const token = open.json('token');
  const device = `k6-${__VU}-${__ITER}`;
  const start = http.get(`${BASE}/api/v1/public/s/${token}?device=${device}`, {
    tags: { step: 'start' },
  });
  if (!check(start, { started: (r) => r.status === 200 })) return;
  // The questionnaire used for load tests is two questions: AGE (number) and SAT (1–5).
  const now = new Date().toISOString();
  const ops = [
    {
      seq: 1,
      kind: 'answer',
      variable: 'AGE',
      oldValue: null,
      newValue: 30 + (__ITER % 50),
      at: now,
      source: 'respondent',
    },
    {
      seq: 2,
      kind: 'answer',
      variable: 'SAT',
      oldValue: null,
      newValue: 1 + (__ITER % 5),
      at: now,
      source: 'respondent',
    },
  ];
  const sync = http.post(
    `${BASE}/api/v1/public/s/${token}/sync`,
    JSON.stringify({ deviceId: device, ops }),
    { ...json, tags: { step: 'sync' } },
  );
  check(sync, { synced: (r) => r.status === 200 });
  const submit = http.post(
    `${BASE}/api/v1/public/s/${token}/submit`,
    JSON.stringify({ deviceId: device, seq: 2, path: ['AGE', 'SAT'] }),
    { ...json, tags: { step: 'submit' } },
  );
  check(submit, { submitted: (r) => r.status === 200 });
}
