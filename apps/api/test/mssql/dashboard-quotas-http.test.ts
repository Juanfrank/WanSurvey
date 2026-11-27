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
  type Session,
  type MssqlTestApp,
} from './harness.js';

const es = (text: string) => ({ es: text });
const definition = (id: string, quotas: { id: string; when: string; target?: number }[]) => ({
  id,
  title: es(id),
  defaultLanguage: 'es',
  languages: ['es'],
  quotas: quotas.map((q) => ({ ...q, name: q.id, max: 10 })),
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [
        {
          kind: 'question',
          id: 'WORK',
          name: 'WORK',
          type: 'single',
          text: es('¿Trabaja?'),
          options: [
            { code: 1, label: es('Sí') },
            { code: 2, label: es('No') },
          ],
        },
      ],
    },
  ],
});

describe.skipIf(!configured)('SQL Server: live dashboard quotas', () => {
  let t: MssqlTestApp;
  let tenant: { id: string };
  let project: string;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
  });
  afterAll(() => t.close());

  async function complete(qid: string, answers: object, sample: object) {
    const v = (
      await sql<{
        id: string;
      }>`SELECT id FROM questionnaire_versions WHERE questionnaire_id = ${qid}`.execute(t.owner)
    ).rows[0]!;
    await sql`INSERT INTO interviews (id, tenant_id, project_id, questionnaire_version_id, mode,
        status, disposition, language, answers, context, device_id, submitted_at, submissions, ended_at)
      VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${v.id}, 'CAWI', 'submitted', 'COMPLETE', 'es',
        ${JSON.stringify(answers)}, ${JSON.stringify({ case: sample })}, 'dev-q',
        SYSDATETIMEOFFSET(), 1, SYSDATETIMEOFFSET())`.execute(t.owner);
  }

  it('counts each quota over its own questionnaire, with the sample fields', async () => {
    const first = await createQuestionnaire(t.owner, tenant.id, project, {
      publish: true,
      definition: definition('FIRST', [{ id: 'WORKERS', when: 'WORK == 1', target: 8 }]),
    });
    const second = await createQuestionnaire(t.owner, tenant.id, project, {
      publish: true,
      definition: definition('SECOND', [{ id: 'NORTH', when: 'case.region == 2' }]),
    });
    await complete(first, { WORK: 1 }, { region: 2 });
    await complete(first, { WORK: 1 }, { region: 2 });
    await complete(second, { WORK: 1 }, { region: 2 });
    await complete(second, { WORK: 2 }, { region: 1 });

    const snap = await pm.agent.get(`/api/v1/projects/${project}/live/snapshot`).expect(200);
    const count = (id: string) =>
      (snap.body.quotas as { id: string; count: number }[]).find((q) => q.id === id)?.count;
    // The second questionnaire's worker is not in the first one's cell.
    expect(count('WORKERS')).toBe(2);
    // The first questionnaire's interviews in region 2 are not in the second one's cell.
    expect(count('NORTH')).toBe(1);
    // A cell's own target, when it has one, goes with its cap.
    const quota = (id: string) =>
      (snap.body.quotas as { id: string; target: number | null }[]).find((q) => q.id === id);
    expect(quota('WORKERS')?.target).toBe(8);
    expect(quota('NORTH')?.target).toBeNull();
  });

  it('carries the planned fieldwork dates and today, and refuses an end before the start', async () => {
    const patch = (fieldwork: object) =>
      pm.agent
        .patch(`/api/v1/projects/${project}`)
        .set('x-csrf-token', pm.csrf)
        .send({ settings: { fieldwork } });
    await patch({ targetCompletes: 120, startsOn: '2026-12-10', endsOn: '2026-12-01' }).expect(400);
    await patch({ targetCompletes: 120, startsOn: '2026-11-13', endsOn: '2026-11-24' }).expect(200);
    const snap = await pm.agent.get(`/api/v1/projects/${project}/live/snapshot`).expect(200);
    expect(snap.body.plan).toMatchObject({ startsOn: '2026-11-13', endsOn: '2026-11-24' });
    expect(snap.body.plan.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Sending only the target keeps the planned dates.
    await patch({ targetCompletes: 150 }).expect(200);
    const again = await pm.agent.get(`/api/v1/projects/${project}/live/snapshot`).expect(200);
    expect(again.body.target).toBe(150);
    expect(again.body.plan).toMatchObject({ startsOn: '2026-11-13', endsOn: '2026-11-24' });
  });

  it('lists interviewers with repeated quality flags awaiting review, for the team only', async () => {
    const ana = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    const v = (
      await sql<{ id: string }>`SELECT TOP 1 v.id FROM questionnaire_versions v
        JOIN questionnaires q ON q.id = v.questionnaire_id
        WHERE q.project_id = ${project}`.execute(t.owner)
    ).rows[0]!;
    const flagged = async (flags: object, status = 'submitted') =>
      sql`INSERT INTO interviews (id, tenant_id, project_id, questionnaire_version_id, mode,
          interviewer_id, status, disposition, language, answers, context, device_id, flags,
          submitted_at, submissions, ended_at)
        VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${v.id}, 'CAPI', ${ana.id}, ${status},
          'COMPLETE', 'es', '{}', '{}', 'dev-r', ${JSON.stringify(flags)},
          SYSDATETIMEOFFSET(), 1, SYSDATETIMEOFFSET())`.execute(t.owner);
    await flagged({ speeding: 900, risk: 30 });
    await flagged({ speeding: 800, straightlining: ['G1'], risk: 50 });
    await flagged({ shortPages: { short: 5, of: 8 }, risk: 25 }, 'in_review');
    await flagged({ otherText: 1 });
    // Approved ones are no longer a risk to review.
    await flagged({ speeding: 700 }, 'approved');

    const res = await pm.agent.get(`/api/v1/projects/${project}/live/risks`).expect(200);
    const row = (res.body.interviewers as { userId: string }[]).find((r) => r.userId === ana.id);
    expect(row).toMatchObject({
      pending: 4,
      flagged: 3,
      kinds: { speeding: 2, straightlining: 1, shortPages: 1 },
    });
    expect(res.body.repeatedFlags).toBe(3);
    // No case deadline is set in this project.
    expect(res.body.expiringSoon).toBeNull();

    const client = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'client_viewer', projectId: project }]),
    );
    await client.agent.get(`/api/v1/projects/${project}/live/risks`).expect(403);
  });
});
