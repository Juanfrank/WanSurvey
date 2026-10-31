import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, newCase as mkCase } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
  type TestUser,
} from './harness.js';

const definition = {
  id: 'PAPER',
  title: { es: 'Papel' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: { es: '¿Edad?' } },
        {
          kind: 'question',
          id: 'SEX',
          name: 'SEX',
          type: 'single',
          text: { es: '¿Sexo?' },
          options: [
            { code: 1, label: { es: 'Hombre' } },
            { code: 2, label: { es: 'Mujer' } },
          ],
        },
      ],
    },
  ],
};

interface Payload {
  interview: { id: string; startedAt: string; entryPass: number };
  context: { case: Record<string, unknown> };
  compiled: CompiledQuestionnaire;
}

/** Paper forms over HTTP on SQL Server: printing, keying, double entry and its differences (test/papi.test.ts). */
describe.skipIf(!configured)('SQL Server: paper forms over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let clerk1: TestUser;
  let k1: Session;
  let k2: Session;
  let supervisor: Session;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    clerk1 = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    k1 = await login(t, clerk1, tenant.slug);
    k2 = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]),
      tenant.slug,
    );
    supervisor = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: project }]),
      tenant.slug,
    );
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  const newCase = (holder: string | null, externalId: string) =>
    mkCase(t.owner, tenant.id, project, {
      holder,
      externalId,
      sample: { city: 'Piura', first_name: 'Ana' },
    });
  const doubleEntry = (on: boolean) =>
    pm.agent
      .patch(`/api/v1/projects/${project}`)
      .set('x-csrf-token', pm.csrf)
      .send({ settings: { papi: { doubleEntry: on } } })
      .expect(200);

  /** Keys a whole form: start (or resume), answer, sync and submit. */
  async function key(s: Session, caseId: string, age: number, sex: number, device: string) {
    const r = await post(s, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'PAPI',
      deviceId: device,
    });
    if (r.status !== 200) return r;
    const p = r.body as Payload;
    const sess = createInterview(p.compiled, {
      mode: 'PAPI',
      language: 'es',
      seed: p.interview.id,
      now: () => new Date(p.interview.startedAt),
      context: { case: p.context.case },
    });
    sess.setAnswer('AGE', age);
    sess.next();
    sess.setAnswer('SEX', sex);
    sess.next();
    const ops = sess.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    await post(s, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id: p.interview.id, ops, state: sess.state() }],
    }).expect(200);
    const sub = await post(s, `/interviews/${p.interview.id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path: sess.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    return { ...r, interviewId: p.interview.id, pass: p.interview.entryPass };
  }

  it('gives the forms to print with the case covers', async () => {
    const a = await newCase(clerk1.id, 'P0001');
    await newCase(null, 'P0002');
    const mine = await k1.agent.get(`/api/v1/projects/${project}/papi/forms`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.cases.map((c: { id: string }) => c.id)).toEqual([a]);
    expect(mine.body.compiled.questionnaire.id).toBe('PAPER');
    const all = await pm.agent.get(
      `/api/v1/projects/${project}/papi/forms?filter=${encodeURIComponent('case.city == "Piura"')}`,
    );
    expect(all.body.cases.length).toBeGreaterThanOrEqual(2);
  });

  it('a clerk keys a form found by its id; with one entry the case is finished', async () => {
    const caseId = await newCase(clerk1.id, 'P0100');
    const look = await k1.agent.get(`/api/v1/projects/${project}/papi/lookup?externalId=P0100`);
    expect(look.body).toEqual({ caseId, externalId: 'P0100', pass: 1, resume: null });
    const done = await key(k1, caseId, 33, 2, 'clerk-desk-0001');
    expect(done).toMatchObject({ pass: 1 });
    const [c] = await rows(sql`SELECT status, disposition FROM cases WHERE id = ${caseId}`);
    expect(c).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
  });

  it('double entry: another clerk keys again, differences are listed and resolved', async () => {
    await doubleEntry(true);
    const caseId = await newCase(clerk1.id, 'P0200');
    const first = (await key(k1, caseId, 41, 1, 'clerk-desk-0001')) as { interviewId: string };
    const [waiting] = await rows(sql`SELECT status FROM cases WHERE id = ${caseId}`);
    expect(waiting!.status).toBe('in_progress');
    // The same clerk cannot key the second entry.
    const same = await k1.agent.get(`/api/v1/projects/${project}/papi/lookup?externalId=P0200`);
    expect(same.body.code).toBe('SAME_CLERK');
    const look = await k2.agent.get(`/api/v1/projects/${project}/papi/lookup?externalId=P0200`);
    expect(look.body.pass).toBe(2);
    // The second clerk types 14 instead of 41.
    const second = (await key(k2, caseId, 14, 1, 'clerk-desk-0002')) as { pass: number };
    expect(second.pass).toBe(2);
    const open = await supervisor.agent.get(`/api/v1/projects/${project}/papi/mismatches`);
    expect(open.body).toEqual([
      expect.objectContaining({
        externalId: 'P0200',
        variable: 'AGE',
        firstValue: 41,
        secondValue: 14,
        status: 'open',
      }),
    ]);
    const [still] = await rows(sql`SELECT status FROM cases WHERE id = ${caseId}`);
    expect(still!.status).toBe('in_progress');
    // Clerks do not resolve.
    expect(
      (
        await post(k2, `/projects/${project}/papi/mismatches/${open.body[0].id}/resolve`, {
          choice: 'second',
        })
      ).status,
    ).toBe(403);
    // The paper says 14: the second entry was right.
    const r = await post(
      supervisor,
      `/projects/${project}/papi/mismatches/${open.body[0].id}/resolve`,
      {
        choice: 'second',
      },
    );
    expect(r.body).toEqual({ resolved: true, value: 14, caseFinished: true });
    const [iv] = await rows(
      sql`SELECT answers, state FROM interviews WHERE id = ${first.interviewId}`,
    );
    expect(JSON.parse(iv!.answers as string).AGE).toBe(14);
    expect(JSON.parse(iv!.state as string).answers.AGE).toBe(14);
    const [ev] =
      await rows(sql`SELECT source, reason, old_value, new_value FROM interview_answer_events
      WHERE interview_id = ${first.interviewId} AND device_id = 'review'`);
    expect(ev).toMatchObject({
      source: 'reviewer',
      reason: 'double_entry',
      old_value: '41',
      new_value: '14',
    });
    const [c] = await rows(sql`SELECT status, disposition FROM cases WHERE id = ${caseId}`);
    expect(c).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
    // Matching entries finish the case straight away.
    const other = await newCase(clerk1.id, 'P0201');
    await key(k1, other, 50, 2, 'clerk-desk-0001');
    await key(k2, other, 50, 2, 'clerk-desk-0002');
    const [c2] = await rows(sql`SELECT status FROM cases WHERE id = ${other}`);
    expect(c2!.status).toBe('finalised');
    // A third entry is refused.
    const third = await k2.agent.get(`/api/v1/projects/${project}/papi/lookup?externalId=P0201`);
    expect(third.body.code).toBe('CASE_CLOSED');
    await doubleEntry(false);
  });
  it('double entry still works when the first entry was reviewed meanwhile', async () => {
    await doubleEntry(true);
    const caseId = await newCase(clerk1.id, 'P0300');
    const first = (await key(k1, caseId, 41, 1, 'clerk-desk-0001')) as { interviewId: string };
    // A supervisor opens (or approves) the first entry before the second is keyed.
    await sql`UPDATE interviews SET status = 'in_review' WHERE id = ${first.interviewId}`.execute(
      t.owner,
    );
    const look = await k2.agent.get(`/api/v1/projects/${project}/papi/lookup?externalId=P0300`);
    expect(look.body.pass).toBe(2);
    expect(
      (await k1.agent.get(`/api/v1/projects/${project}/papi/lookup?externalId=P0300`)).body.code,
    ).toBe('SAME_CLERK');
    const second = (await key(k2, caseId, 14, 1, 'clerk-desk-0002')) as { pass: number };
    expect(second.pass).toBe(2);
    const open = await supervisor.agent.get(`/api/v1/projects/${project}/papi/mismatches`);
    expect(open.body).toEqual([
      expect.objectContaining({
        externalId: 'P0300',
        variable: 'AGE',
        firstValue: 41,
        secondValue: 14,
      }),
    ]);
    await doubleEntry(false);
  });
});
