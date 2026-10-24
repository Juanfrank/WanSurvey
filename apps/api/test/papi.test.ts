import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
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

describe('paper forms', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let qid: string;
  let clerk1: TestUser;
  let k1: Session;
  let k2: Session;
  let supervisor: Session;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { definition, publish: true });
    clerk1 = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
    k1 = await login(t.app, clerk1);
    k2 = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]),
    );
    supervisor = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'supervisor', projectId: project }]),
    );
    pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  async function newCase(holder: string | null, externalId: string) {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
      values (${id}, ${tenant.id}, ${project}, ${externalId}, ${t.admin.json({ city: 'Piura', first_name: 'Ana' })},
              ${holder ? 'assigned' : 'fresh'}, ${holder})`;
    return id;
  }
  const doubleEntry = (on: boolean) =>
    pm.agent
      .patch(`/api/v1/projects/${project}`)
      .set('x-csrf-token', pm.csrf)
      .send({ settings: { papi: { doubleEntry: on } } })
      .expect(200);

  /** Keys a whole form: start (or resume), answer, sync and submit. */
  async function key(s: Session, caseId: string, age: number, sex: number, device: string) {
    const r = await post(s, `/projects/${project}/interviews`, {
      id: uuidv7(),
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
    const [c] = await t.admin`select status, disposition from cases where id = ${caseId}`;
    expect(c).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
  });

  it('double entry: another clerk keys again, differences are listed and resolved', async () => {
    await doubleEntry(true);
    const caseId = await newCase(clerk1.id, 'P0200');
    const first = (await key(k1, caseId, 41, 1, 'clerk-desk-0001')) as { interviewId: string };
    const [waiting] = await t.admin`select status from cases where id = ${caseId}`;
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
    const [still] = await t.admin`select status from cases where id = ${caseId}`;
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
    const [iv] =
      await t.admin`select answers, state from interviews where id = ${first.interviewId}`;
    expect(iv!.answers.AGE).toBe(14);
    expect(iv!.state.answers.AGE).toBe(14);
    const [ev] =
      await t.admin`select source, reason, old_value, new_value from interview_answer_events
      where interview_id = ${first.interviewId} and device_id = 'review'`;
    expect(ev).toMatchObject({
      source: 'reviewer',
      reason: 'double_entry',
      old_value: 41,
      new_value: 14,
    });
    const [c] = await t.admin`select status, disposition from cases where id = ${caseId}`;
    expect(c).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
    // Matching entries finish the case straight away.
    const other = await newCase(clerk1.id, 'P0201');
    await key(k1, other, 50, 2, 'clerk-desk-0001');
    await key(k2, other, 50, 2, 'clerk-desk-0002');
    const [c2] = await t.admin`select status from cases where id = ${other}`;
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
    await t.admin`update interviews set status = 'in_review' where id = ${first.interviewId}`;
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
