/* global __ENV, __VU, __ITER */
// CAWI: web respondents coming through the open link, each with an address of their own: open the
// link, start, send the answers, submit. 50 completes a second by default (spec §11);
// PROFILE=ramp raises the rate step by step to find where the deployment stops keeping up.
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { cawiSubmit, cawiSync } from './flows.js';
import { API, expect, ipFor, summaryTrendStats, thresholds } from './lib.js';

const SLUG = __ENV.SLUG ?? 'load-open';
const RATE = Number(__ENV.RATE ?? 50);

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
    stages: [25, 50, 75, 100, 125, 150].map((target) => ({ target, duration: '30s' })),
  },
};
const profile = __ENV.PROFILE ?? 'burst';

export const options = {
  scenarios: { [profile]: scenarios[profile] },
  summaryTrendStats,
  thresholds: { ...thresholds, completes_failed: ['count<1'] },
};

const completeTime = new Trend('complete_duration', true);
const completesFailed = new Counter('completes_failed');

export default function () {
  const n = __VU * 100000 + __ITER;
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ipFor(n) };
  const t0 = Date.now();
  const open = http.post(`${API}/public/o/${SLUG}/start`, '{}', {
    headers,
    tags: { step: 'open' },
  });
  if (!expect(open, 'opened')) return completesFailed.add(1);
  const token = open.json('token');
  const device = `k6-browser-${__VU}-${__ITER}`;
  const start = http.get(`${API}/public/s/${token}?device=${device}`, {
    headers,
    tags: { step: 'start' },
  });
  if (!expect(start, 'started')) return completesFailed.add(1);
  const sync = http.post(`${API}/public/s/${token}/sync`, JSON.stringify(cawiSync(device, n)), {
    headers,
    tags: { step: 'sync' },
  });
  if (!expect(sync, 'synced')) return completesFailed.add(1);
  const submit = http.post(`${API}/public/s/${token}/submit`, JSON.stringify(cawiSubmit(device)), {
    headers,
    tags: { step: 'submit' },
  });
  if (!expect(submit, 'submitted')) return completesFailed.add(1);
  completeTime.add(Date.now() - t0);
}
