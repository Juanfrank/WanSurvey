import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import request from 'supertest';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSetup, type LoadUsers } from '../../src/db/load-setup.js';
import { ADMIN_URL, bootstrap, configured, unique, type MssqlTestApp } from './harness.js';

// The requests the k6 scenarios send (load/flows.js), played once against the real API, so that
// a change to the API that breaks the load tests breaks this test first.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Flows = Record<string, (...a: any[]) => any>;

describe.skipIf(!configured)('SQL Server: the requests of the load tests', () => {
  let t: MssqlTestApp;
  let data: LoadUsers;
  let f: Flows;
  const password = 'load-password-123';

  beforeAll(async () => {
    t = await bootstrap();
    f = (await import(
      pathToFileURL(resolve(__dirname, '../../../../load/flows.js')).href
    )) as Flows;
    data = await loadSetup(ADMIN_URL!, {
      cati: 1,
      capi: 1,
      catiCases: 3,
      capiCases: 2,
      password,
      slug: unique('load-open'),
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  async function signIn(email: string) {
    const agent = request.agent(t.app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const csrf = res.body.csrfToken as string;
    const post = (path: string, body: object = {}) =>
      agent.post(`/api/v1${path}`).set('x-csrf-token', csrf).send(body);
    return post;
  }

  it('CAWI: open link, start, sync, submit', async () => {
    const api = () => request(t.app.getHttpServer());
    const open = await api().post(`/api/v1/public/o/${data.slug}/start`).send({});
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const token = open.body.token as string;
    const device = 'k6-browser-1-1';
    expect((await api().get(`/api/v1/public/s/${token}?device=${device}`)).status).toBe(200);
    const sync = await api().post(`/api/v1/public/s/${token}/sync`).send(f.cawiSync!(device, 1));
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    const submit = await api().post(`/api/v1/public/s/${token}/submit`).send(f.cawiSubmit!(device));
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
  });

  it('CATI: next case, answered, sync, submit; another outcome on the next', async () => {
    const post = await signIn(data.cati[0]!.email);
    const device = 'k6-phone-1';
    const next = await post(`/projects/${data.projectId}/cati/next`);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    const id = f.uuid!() as string;
    const answered = await post(
      `/cati/attempts/${next.body.attempt.id}/outcome`,
      f.catiAnswered!(id, device, data.questionnaireId),
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const sync = await post('/interviews/sync', f.deviceSync!(device, id, 1));
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect(sync.body.acks[id]).toBe(3);
    const submit = await post(`/interviews/${id}/submit`, f.deviceSubmit!(device));
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);

    const second = await post(`/projects/${data.projectId}/cati/next`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const no = await post(`/cati/attempts/${second.body.attempt.id}/outcome`, {
      outcome: 'no_answer',
    });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
  });

  it('CAPI: checkout, interview created by the sync, synced again, submitted', async () => {
    const user = data.capi[0]!;
    const post = await signIn(user.email);
    const device = 'k6-tablet-1';
    const co = await post(`/projects/${data.projectId}/capi/checkout`, {
      deviceId: device,
      caseIds: user.caseIds,
      questionnaireId: data.questionnaireId,
    });
    expect(co.status, JSON.stringify(co.body)).toBe(200);
    expect(co.body.cases).toHaveLength(user.caseIds.length);
    const c = co.body.cases[0] as { caseId: string; questionnaireVersionId: string };
    const id = f.uuid!() as string;
    const start = f.capiStart!(c.caseId, c.questionnaireVersionId);
    const first = await post('/interviews/sync', f.deviceSync!(device, id, 1, start));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.errors).toEqual({});
    const again = await post('/interviews/sync', f.deviceSync!(device, id, 1));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const submit = await post(`/interviews/${id}/submit`, f.deviceSubmit!(device));
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    const [row] = (
      await sql<{ status: string }>`SELECT status FROM interviews WHERE id = ${id}`.execute(t.owner)
    ).rows;
    expect(row?.status).toBe('submitted');
  });
});
