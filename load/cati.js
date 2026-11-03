/* global __ENV, __VU, open */
// CATI: telephone interviewers working the call queue. Each signs in once, then loops: ask for
// the next case, "dial" for a few seconds, record the outcome; when someone answers, the
// interview is started, its answers synced and submitted. `users.json` is written by
// `pnpm --filter @wansurvey/api db:load-setup`.
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { catiAnswered, deviceSubmit, deviceSync, uuid } from './flows.js';
import { expect, ipFor, post, signIn, summaryTrendStats, thresholds } from './lib.js';

const DATA = JSON.parse(open(__ENV.USERS ?? './users.json'));
const VUS = Math.min(Number(__ENV.VUS ?? DATA.cati.length), DATA.cati.length);
const queueEmpty = new Counter('cati_queue_empty');
const completes = new Counter('cati_completes');

export const options = {
  scenarios: {
    cati: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: VUS, duration: __ENV.RAMP ?? '30s' },
        { target: VUS, duration: __ENV.DURATION ?? '3m' },
      ],
      gracefulRampDown: '30s',
    },
  },
  summaryTrendStats,
  thresholds: {
    ...thresholds,
    'http_req_duration{step:next}': ['p(95)<800'],
    'http_req_duration{step:outcome}': ['p(95)<800'],
  },
};

const session = {};
const OTHER = ['no_answer', 'busy', 'voicemail', 'refusal'];

export default function () {
  const me = (session[__VU] ??= { n: 0 });
  if (!me.headers) {
    me.headers = signIn(DATA.cati[__VU - 1].email, DATA.password, ipFor(__VU));
    if (!me.headers) return sleep(10);
    me.device = `k6-phone-${__VU}`;
  }
  const { headers } = me;
  const next = post(`/projects/${DATA.projectId}/cati/next`, headers, {}, 'next');
  if (next.status === 204) {
    queueEmpty.add(1);
    return sleep(5);
  }
  if (!expect(next, 'next case')) return sleep(5);
  const attempt = next.json('attempt.id');
  sleep(2 + Math.random() * 4); // dialling and ringing
  me.n += 1;
  const n = __VU * 10000 + me.n;
  if (Math.random() < 0.5) {
    const id = uuid();
    const answered = post(
      `/cati/attempts/${attempt}/outcome`,
      headers,
      catiAnswered(id, me.device, DATA.questionnaireId),
      'outcome',
    );
    if (!expect(answered, 'answered')) return;
    sleep(3 + Math.random() * 4); // the conversation
    const sync = post('/interviews/sync', headers, deviceSync(me.device, id, n), 'sync');
    if (!check(sync, { synced: (r) => r.status === 200 && r.json(`acks.${id}`) === 3 })) return;
    const submit = post(`/interviews/${id}/submit`, headers, deviceSubmit(me.device), 'submit');
    if (expect(submit, 'submitted')) completes.add(1);
  } else {
    expect(
      post(
        `/cati/attempts/${attempt}/outcome`,
        headers,
        { outcome: OTHER[n % OTHER.length] },
        'outcome',
      ),
      'outcome recorded',
    );
  }
  sleep(1 + Math.random() * 2); // wrap-up
}
