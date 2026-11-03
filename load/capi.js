/* global __ENV, __VU, open */
// CAPI: tablets working offline. Each interviewer signs in, downloads their cases to the device
// (checkout), and then, one interview at a time, syncs what was answered on the device (the
// interview is created by that sync) and submits it. A tablet also syncs on its own rhythm, so
// every iteration sends a second sync before the submission.
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { capiStart, deviceSubmit, deviceSync, uuid } from './flows.js';
import { expect, ipFor, post, signIn, summaryTrendStats, thresholds } from './lib.js';

const DATA = JSON.parse(open(__ENV.USERS ?? './users.json'));
const VUS = Math.min(Number(__ENV.VUS ?? DATA.capi.length), DATA.capi.length);
const completes = new Counter('capi_completes');

export const options = {
  scenarios: {
    capi: {
      executor: 'ramping-vus',
      startVUs: 0,
      // Everyone signs in within the first 30 s, as at the start of a field day.
      stages: [
        { target: VUS, duration: __ENV.RAMP ?? '30s' },
        { target: VUS, duration: __ENV.DURATION ?? '3m' },
      ],
      gracefulRampDown: '30s',
    },
  },
  summaryTrendStats,
  thresholds: { ...thresholds, 'http_req_duration{step:checkout}': ['p(95)<2000'] },
};

const session = {};

export default function () {
  const me = (session[__VU] ??= { done: 0 });
  const user = DATA.capi[__VU - 1];
  if (!me.headers) {
    me.headers = signIn(user.email, DATA.password, ipFor(__VU));
    if (!me.headers) return sleep(10);
    me.device = `k6-tablet-${__VU}`;
    const co = post(
      `/projects/${DATA.projectId}/capi/checkout`,
      me.headers,
      { deviceId: me.device, caseIds: user.caseIds, questionnaireId: DATA.questionnaireId },
      'checkout',
    );
    if (!expect(co, 'checked out')) {
      me.headers = null;
      return sleep(10);
    }
    me.cases = co.json('cases').map((c) => ({
      id: c.caseId,
      versionId: c.questionnaireVersionId,
    }));
  }
  const next = me.cases[me.done];
  if (!next) return sleep(30); // every case of the tablet is done
  const { headers, device } = me;
  const id = uuid();
  const n = __VU * 10000 + me.done;
  sleep(5 + Math.random() * 10); // the conversation, on the device
  const start = capiStart(next.id, next.versionId);
  const first = post('/interviews/sync', headers, deviceSync(device, id, n, start), 'sync');
  if (!expect(first, 'created by sync')) return;
  sleep(2 + Math.random() * 3);
  const again = post('/interviews/sync', headers, deviceSync(device, id, n), 'sync');
  if (!expect(again, 'synced again')) return;
  const submit = post(`/interviews/${id}/submit`, headers, deviceSubmit(device), 'submit');
  if (expect(submit, 'submitted')) {
    completes.add(1);
    me.done += 1;
  }
}
