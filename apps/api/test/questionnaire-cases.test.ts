import { sampleTable, toCsv } from '@wansurvey/fixtures';
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

/** Each questionnaire of a project has its own cases, sample and assignment rules. */
describe('cases per questionnaire', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let first: string;
  let second: string;
  let pm: Session;
  let interviewer: TestUser;
  let me: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    first = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    second = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    interviewer = await createUser(t.admin, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    me = await login(t.app, interviewer);
    base = `/api/v1/projects/${project}`;
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);

  async function importInto(questionnaireId: string | null, n: number) {
    const req = pm.agent
      .post(`${base}/imports`)
      .set('x-csrf-token', pm.csrf)
      .attach('file', Buffer.from(toCsv(sampleTable(n))), 'sample.csv');
    const up = await (questionnaireId ? req.field('questionnaireId', questionnaireId) : req);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const m = await pm.agent
      .put(`${base}/imports/${up.body.id}/mapping`)
      .set('x-csrf-token', pm.csrf)
      .send(up.body.suggested);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const done = await post(pm, `${base}/imports/${up.body.id}/commit`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return done.body as { created: number };
  }
  const listOf = (questionnaireId?: string) =>
    pm.agent
      .get(`${base}/cases`)
      .query({ limit: 100, ...(questionnaireId ? { questionnaireId } : {}) });

  it('imports the same ids into two questionnaires and lists each one apart', async () => {
    // Without a questionnaire the import goes to the project's first one.
    expect((await importInto(null, 5)).created).toBe(5);
    expect((await importInto(second, 5)).created).toBe(5);
    const a = await listOf(first);
    const b = await listOf(second);
    expect(a.body.total).toBe(5);
    expect(b.body.total).toBe(5);
    expect(
      b.body.rows.every((r: { questionnaireId: string }) => r.questionnaireId === second),
    ).toBe(true);
    expect((await listOf()).body.total).toBe(10);
    expect(b.body.completed).toBe(0);
    const imports = await pm.agent.get(`${base}/imports`).query({ questionnaireId: second });
    expect(imports.body).toHaveLength(1);
    expect((await listOf(uuidv7())).status).toBe(200);
    expect((await importInto(uuidv7(), 1).catch((e: Error) => e)) instanceof Error).toBe(true);
  });

  it('runs a questionnaire’s rules on the selected cases only, and dates the assignment', async () => {
    const rule = await post(pm, `${base}/assignments`, {
      userId: interviewer.id,
      questionnaireId: second,
      filter: 'true',
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(rule.body.questionnaireId).toBe(second);
    const rules = await pm.agent.get(`${base}/assignments`).query({ questionnaireId: first });
    expect(rules.body).toHaveLength(0);

    const ofFirst = (await listOf(first)).body.rows.map((r: { id: string }) => r.id);
    const ofSecond = (await listOf(second)).body.rows.map((r: { id: string }) => r.id);
    // The rule is for the second questionnaire: the first one's cases are left alone.
    expect((await post(pm, `${base}/assignments/apply`, { caseIds: ofFirst })).body.assigned).toBe(
      0,
    );
    const applied = await post(pm, `${base}/assignments/apply`, { caseIds: ofSecond.slice(0, 2) });
    expect(applied.body.assigned).toBe(2);
    const rows = (await listOf(second)).body.rows.filter(
      (r: { assignedTo: string | null }) => r.assignedTo,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Date.parse(r.assignedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect((await listOf(second)).body.counts.assigned).toBe(2);

    // A case of the second questionnaire is not interviewed with the first.
    const start = await post(me, `${base}/interviews`, {
      id: uuidv7(),
      caseId: rows[0].id,
      questionnaireId: first,
      mode: 'CAPI',
      deviceId: 'device-q-1',
    });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('OTHER_QUESTIONNAIRE');

    // Released, the date goes too.
    const release = await post(pm, `${base}/cases/assign`, { caseIds: [rows[0].id], userId: null });
    expect(release.status, JSON.stringify(release.body)).toBeLessThan(300);
    const [c] = await t.admin`select assigned_at from cases where id = ${rows[0].id}`;
    expect(c!.assigned_at).toBeNull();
  });

  it('keeps one sampling plan per questionnaire', async () => {
    const plan = { design: { family: 'census', method: 'census' } };
    const put = (q: string) =>
      pm.agent
        .put(`${base}/sampling`)
        .query({ questionnaireId: q })
        .set('x-csrf-token', pm.csrf)
        .send(plan);
    expect((await put(second)).status).toBe(200);
    const a = await pm.agent.get(`${base}/sampling`).query({ questionnaireId: first });
    const b = await pm.agent.get(`${base}/sampling`).query({ questionnaireId: second });
    expect(a.body.questionnaireId).toBe(first);
    expect(b.body.questionnaireId).toBe(second);
    expect(b.body.plan.design.family).toBe('census');
    expect(a.body.plan.design.family).not.toBe('census');
    const plans =
      await t.admin`select questionnaire_id from sampling_plans where project_id = ${project}`;
    expect(plans.map((p) => p.questionnaire_id)).toEqual([second]);
  });
});
