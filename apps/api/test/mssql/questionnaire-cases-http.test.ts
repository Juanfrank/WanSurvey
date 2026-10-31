import { sampleTable, toCsv } from '@wansurvey/fixtures';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire } from './fixtures.js';
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

/** Each questionnaire of a project has its own cases, sample and assignment rules. */
describe.skipIf(!configured)('SQL Server: cases per questionnaire', () => {
  let t: MssqlTestApp;
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
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    first = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    second = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    interviewer = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    me = await login(t, interviewer, tenant.slug);
    base = `/api/v1/projects/${project}`;
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

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
    expect((await listOf(randomUUID())).status).toBe(200);
    expect((await importInto(randomUUID(), 1).catch((e: Error) => e)) instanceof Error).toBe(true);
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
    const assigned = (await listOf(second)).body.rows.filter(
      (r: { assignedTo: string | null }) => r.assignedTo,
    );
    expect(assigned).toHaveLength(2);
    for (const r of assigned) expect(Date.parse(r.assignedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect((await listOf(second)).body.counts.assigned).toBe(2);

    // A case of the second questionnaire is not interviewed with the first.
    const start = await post(me, `${base}/interviews`, {
      id: randomUUID(),
      caseId: assigned[0].id,
      questionnaireId: first,
      mode: 'CAPI',
      deviceId: 'device-q-1',
    });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('OTHER_QUESTIONNAIRE');

    // Released, the date goes too.
    const release = await post(pm, `${base}/cases/assign`, {
      caseIds: [assigned[0].id],
      userId: null,
    });
    expect(release.status, JSON.stringify(release.body)).toBeLessThan(300);
    const [c] = await rows(sql`SELECT assigned_at FROM cases WHERE id = ${assigned[0].id}`);
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
    const plans = await rows(
      sql`SELECT questionnaire_id FROM sampling_plans WHERE project_id = ${project}`,
    );
    expect(plans.map((p) => (p.questionnaire_id as string).toLowerCase())).toEqual([second]);
  });
});
