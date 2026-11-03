/* global __ENV, console */
// What the k6 scenarios share: base address, sign-in and request headers.
import http from 'k6/http';
import { check } from 'k6';

export const BASE = __ENV.BASE ?? 'http://localhost:3000';
export const API = `${BASE}/api/v1`;

/** Each simulated person has an address of their own, so per-address limits apply to each. */
export const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

/**
 * Signs in once; returns the headers for the session. The cookie is sent back by hand because
 * production cookies are Secure and the load goes over plain HTTP to the API.
 */
export function signIn(email, password, ip) {
  const base = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  const res = http.post(`${API}/auth/login`, JSON.stringify({ email, password }), {
    headers: base,
    tags: { step: 'login' },
  });
  if (!check(res, { 'logged in': (r) => r.status === 200 })) {
    if (__ENV.DEBUG) console.log('login', res.status, res.body);
    return null;
  }
  const cookie = Object.entries(res.cookies)
    .map(([name, values]) => `${name}=${values[0].value}`)
    .join('; ');
  return { ...base, cookie, 'x-csrf-token': res.json('csrfToken') };
}

export const post = (path, headers, body, step) =>
  http.post(`${API}${path}`, JSON.stringify(body ?? {}), { headers, tags: { step } });

/** Gives a debug line when asked (DEBUG=1) and the check failed. */
export function expect(res, step, ok = 200) {
  const good = check(res, { [step]: (r) => r.status === ok });
  if (!good && __ENV.DEBUG) console.log(step, res.status, String(res.body).slice(0, 300));
  return good;
}

export const thresholds = {
  http_req_failed: ['rate<0.01'],
  'http_req_duration{step:login}': ['p(95)<2000'],
  'http_req_duration{step:sync}': ['p(95)<800'],
  'http_req_duration{step:submit}': ['p(95)<800'],
};

export const summaryTrendStats = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];
