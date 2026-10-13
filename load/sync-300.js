/* global __ENV, __VU, open */
// 300 interviewers syncing concurrently (spec §11): each signs in once, then sends a batch of
// answer changes for its interview in progress every 10 seconds. `USERS` is a JSON file of
// [{ "email", "interviewId", "deviceId" }], one per interviewer, with the interview started on
// that device beforehand.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE ?? 'http://localhost:3000';
const PASSWORD = __ENV.PASSWORD ?? 'demo-password-123';

export const options = {
  scenarios: {
    sync: { executor: 'constant-vus', vus: 300, duration: '3m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{step:sync}': ['p(95)<800'],
  },
};

const json = { 'content-type': 'application/json' };
const USERS = JSON.parse(open(__ENV.USERS ?? './sync-users.json'));
const state = {};

export default function () {
  const user = USERS[(__VU - 1) % USERS.length];
  let me = state[__VU];
  if (!me) {
    const login = http.post(
      `${BASE}/api/v1/auth/login`,
      JSON.stringify({ email: user.email, password: PASSWORD }),
      { headers: json, tags: { step: 'login' } },
    );
    if (!check(login, { 'logged in': (r) => r.status === 200 })) return sleep(10);
    // Change numbers continue after the last one the server acknowledged.
    const last = http.get(`${BASE}/api/v1/interviews/${user.interviewId}`, {
      tags: { step: 'resume' },
    });
    me = state[__VU] = { csrf: login.json('csrfToken'), seq: last.json('lastSeq') ?? 0 };
  }
  const ops = [1, 2, 3].map(() => ({
    seq: ++me.seq,
    kind: 'answer',
    variable: 'E6_COMMENTS',
    oldValue: null,
    newValue: `load ${me.seq}`,
    at: new Date().toISOString(),
    source: 'interviewer',
  }));
  const r = http.post(
    `${BASE}/api/v1/interviews/sync`,
    JSON.stringify({ deviceId: user.deviceId, interviews: [{ id: user.interviewId, ops }] }),
    { headers: { ...json, 'x-csrf-token': me.csrf }, tags: { step: 'sync' } },
  );
  check(r, { synced: (x) => x.status === 200 });
  sleep(10);
}
