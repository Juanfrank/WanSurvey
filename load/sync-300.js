/* global __ENV, __VU, open, console */
// 300 interviewers syncing concurrently (spec §11): each signs in once, starts the interview
// of its case on its device, then sends a batch of answer changes every 10 seconds (the
// app's own rhythm). `USERS` is the file apps/api/scripts/load-setup.ts writes:
// [{ email, projectId, caseId, questionnaireId }].
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE ?? 'http://localhost:3000';
const PASSWORD = __ENV.PASSWORD ?? 'load-password-123';
const VUS = Number(__ENV.VUS ?? 300);

export const options = {
  scenarios: {
    sync: {
      executor: 'ramping-vus',
      startVUs: 0,
      // Everyone signs in within the first 30 s, as at the start of a field day.
      stages: [
        { target: VUS, duration: '30s' },
        { target: VUS, duration: __ENV.DURATION ?? '3m' },
      ],
      gracefulRampDown: '15s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{step:sync}': ['p(95)<800'],
    'http_req_duration{step:login}': ['p(95)<2000'],
  },
};

const USERS = JSON.parse(open(__ENV.USERS ?? './sync-users.json'));
const state = {};

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export default function () {
  const user = USERS[(__VU - 1) % USERS.length];
  // Each tablet has its own address (mobile data), so the sign-in limit per address is theirs.
  const base = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.200.${__VU >> 8}.${__VU & 255}`,
  };
  let me = state[__VU];
  if (!me) {
    const login = http.post(
      `${BASE}/api/v1/auth/login`,
      JSON.stringify({ email: user.email, password: PASSWORD }),
      { headers: base, tags: { step: 'login' } },
    );
    if (!check(login, { 'logged in': (r) => r.status === 200 })) return sleep(10);
    // Production cookies are Secure, and this runs over plain HTTP to the API (TLS ends at
    // the proxy): the session cookie is sent back by hand.
    const cookie = Object.entries(login.cookies)
      .map(([name, values]) => `${name}=${values[0].value}`)
      .join('; ');
    const headers = { ...base, cookie, 'x-csrf-token': login.json('csrfToken') };
    const deviceId = `tablet-${__VU}-${Date.now()}`;
    const started = http.post(
      `${BASE}/api/v1/projects/${user.projectId}/interviews`,
      JSON.stringify({
        id: uuid(),
        caseId: user.caseId,
        questionnaireId: user.questionnaireId,
        mode: 'CAPI',
        deviceId,
      }),
      { headers, tags: { step: 'start' } },
    );
    if (!check(started, { started: (r) => r.status === 200 })) {
      if (__ENV.DEBUG) console.log(started.status, started.body);
      return sleep(10);
    }
    me = state[__VU] = {
      headers,
      deviceId,
      id: started.json('interview.id'),
      seq: started.json('interview.lastSeq') ?? started.json('lastSeq') ?? 0,
    };
  }
  const ops = [1, 2, 3].map(() => ({
    seq: ++me.seq,
    kind: 'answer',
    variable: 'COMMENTS',
    oldValue: null,
    newValue: `carga ${me.seq}`,
    at: new Date().toISOString(),
    source: 'interviewer',
  }));
  const r = http.post(
    `${BASE}/api/v1/interviews/sync`,
    JSON.stringify({ deviceId: me.deviceId, interviews: [{ id: me.id, ops }] }),
    { headers: me.headers, tags: { step: 'sync' } },
  );
  if (
    !check(r, { synced: (x) => x.status === 200 && x.json(`acks.${me.id}`) === me.seq }) &&
    __ENV.DEBUG
  )
    console.log(r.status, r.body, me.id);
  // 10 s ± 20 %, as the app spaces its syncs.
  sleep(8 + Math.random() * 4);
}
