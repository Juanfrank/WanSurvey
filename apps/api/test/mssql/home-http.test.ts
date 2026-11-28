import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, get, newCase } from './fixtures.js';
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

/** The home page's summary per role over HTTP on SQL Server. */
describe.skipIf(!configured)('SQL Server: home summary', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let other: string;
  let ana: TestUser;
  let anaS: Session;
  let supervisor: Session;
  let stranger: Session;
  let due: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    other = await createProject(t.owner, tenant.id);
    const qid = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    ana = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    anaS = await login(t, ana, tenant.slug);
    supervisor = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor' }]),
      tenant.slug,
    );
    stranger = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: other }]),
      tenant.slug,
    );
    // Ana: two open cases, one with a callback due an hour ago, one later; one free case.
    due = await newCase(t.owner, tenant.id, project, { holder: ana.id, externalId: 'DUE1' });
    const later = await newCase(t.owner, tenant.id, project, { holder: ana.id });
    await newCase(t.owner, tenant.id, project);
    await sql`UPDATE cases SET disposition = 'CALLBACK',
        next_contact_at = DATEADD(hour, -1, SYSDATETIMEOFFSET()) WHERE id = ${due}`.execute(
      t.owner,
    );
    await sql`UPDATE cases SET disposition = 'CALLBACK',
        next_contact_at = DATEADD(hour, 3, SYSDATETIMEOFFSET()) WHERE id = ${later}`.execute(
      t.owner,
    );
    // One interview of hers sent back, one waiting for review flagged as too fast.
    const v = (
      (
        await sql`SELECT id FROM questionnaire_versions WHERE questionnaire_id = ${qid}`.execute(
          t.owner,
        )
      ).rows as { id: string }[]
    )[0]!;
    for (const [status, flags] of [
      ['returned', '{}'],
      ['submitted', '{"speeding":800}'],
    ] as const)
      await sql`INSERT INTO interviews (id, tenant_id, project_id, questionnaire_version_id, mode,
          interviewer_id, status, disposition, language, device_id, submitted_at, submissions, flags)
        VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${v.id}, 'CAPI', ${ana.id}, ${status},
          'COMPLETE', 'es', 'dev-home', SYSDATETIMEOFFSET(), 1, ${flags})`.execute(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("gives the interviewer her day and nothing of the team's", async () => {
    const res = await get(anaS, '/home').expect(200);
    expect(res.body.projects).toHaveLength(1);
    const p = res.body.projects[0];
    expect(p).toMatchObject({
      id: project,
      field: null,
      review: null,
      mine: { open: 2, callbacksDue: 1, returned: 1 },
    });
    expect(p.mine.nextCallbackAt).toEqual(expect.any(String));
    expect(res.body.dueCallbacks).toEqual([
      { projectId: project, caseId: due, externalId: 'DUE1', at: expect.any(String) },
    ]);
  });

  it('gives the supervisor the fieldwork and the review queue of every project', async () => {
    const res = await get(supervisor, '/home').expect(200);
    const p = res.body.projects.find((x: { id: string }) => x.id === project);
    expect(p).toMatchObject({
      field: { cases: 3, unassigned: 1, callbacksDue: 1, lastActivityAt: expect.any(String) },
      review: { toReview: 1, tooFast: 1 },
      mine: null,
    });
    expect(res.body.projects.map((x: { id: string }) => x.id)).toContain(other);
    expect(res.body.dueCallbacks).toEqual([]);
  });

  it('shows nothing of a project one does not work in', async () => {
    const res = await get(stranger, '/home').expect(200);
    expect(res.body.projects.map((x: { id: string }) => x.id)).toEqual([other]);
    expect(res.body.projects[0].mine).toEqual({
      open: 0,
      callbacksDue: 0,
      nextCallbackAt: null,
      returned: 0,
    });
  });
});
