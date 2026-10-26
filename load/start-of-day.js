/* global __ENV, open, console */
// Start of a field day: every interviewer signs in with Microsoft within WINDOW seconds
// (default 120; WINDOW=30 for everyone at once) and opens the app. Each one:
//   1. GET sso/start                  → redirect to Microsoft (the mock, apps/api/scripts/load-mock-entra.ts)
//   2. GET sso/callback?code&state    → the API redeems the code with "Microsoft", opens a session
//   3. GET auth/me, GET projects      → what the app loads first
// The code is self-describing for the mock: the e-mail, the Microsoft object id and the nonce the
// API put in the authorize URL. EMAIL=0 starts without an e-mail (the single sign-in button).
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import encoding from 'k6/encoding';

const BASE = __ENV.BASE ?? 'http://localhost:3000';
const USERS = JSON.parse(open(__ENV.USERS ?? './sync-users.json'));
const N = Number(__ENV.N ?? USERS.length);
const WINDOW = Number(__ENV.WINDOW ?? 120);
const WITH_EMAIL = (__ENV.EMAIL ?? '1') !== '0';

export const options = {
  scenarios: {
    morning: {
      executor: 'constant-arrival-rate',
      rate: N,
      timeUnit: `${WINDOW}s`,
      duration: `${WINDOW}s`,
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    signin_total: ['p(95)<2000'],
    checks: ['rate>0.99'],
  },
};

const total = new Trend('signin_total', true);
const cookieOf = (res, name) => res.cookies[name]?.[0]?.value;

export default function () {
  const i = exec.scenario.iterationInTest % USERS.length;
  const user = USERS[i];
  const headers = { 'x-forwarded-for': `10.150.${i >> 8}.${i & 255}` };
  const t0 = Date.now();
  const q = WITH_EMAIL ? `email=${encodeURIComponent(user.email)}&returnTo=%2F` : 'returnTo=%2F';
  const start = http.get(`${BASE}/api/v1/auth/sso/start?${q}`, {
    headers,
    redirects: 0,
    tags: { step: 'start' },
  });
  const to = start.headers.Location ?? '';
  if (
    !check(start, {
      'to Microsoft': (r) => r.status === 302 && to.includes('/oauth2/v2.0/authorize'),
    })
  ) {
    if (__ENV.DEBUG) console.log('start', start.status, to, start.body.slice(0, 200));
    return;
  }
  const params = Object.fromEntries(
    to
      .split('?')[1]
      .split('&')
      .map((kv) => kv.split('=').map(decodeURIComponent)),
  );
  const code = encoding.b64encode(
    JSON.stringify({
      email: user.email,
      oid: `oid-${i}`,
      name: `Entrevistador ${i}`,
      nonce: params.nonce,
    }),
    'rawurl',
  );
  // Production cookies are Secure and this runs over plain HTTP: they are sent back by hand.
  const back = http.get(
    `${BASE}/api/v1/auth/sso/callback?code=${code}&state=${encodeURIComponent(params.state)}`,
    {
      headers: { ...headers, cookie: `ws_sso=${cookieOf(start, 'ws_sso')}` },
      redirects: 0,
      tags: { step: 'callback' },
    },
  );
  const sid = cookieOf(back, 'ws_sid');
  if (
    !check(back, {
      'signed in': (r) => r.status === 302 && !!sid && !r.headers.Location.includes('sso_error'),
    })
  ) {
    if (__ENV.DEBUG)
      console.log('callback', back.status, back.headers.Location, back.body.slice(0, 200));
    return;
  }
  const session = { ...headers, cookie: `ws_sid=${sid}` };
  const me = http.get(`${BASE}/api/v1/auth/me`, { headers: session, tags: { step: 'me' } });
  check(me, { me: (r) => r.status === 200 });
  const projects = http.get(`${BASE}/api/v1/projects`, {
    headers: session,
    tags: { step: 'projects' },
  });
  check(projects, { projects: (r) => r.status === 200 });
  total.add(Date.now() - t0);
}
