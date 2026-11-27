import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/** A project's status moves, audited, with what is still open before closing it. */
describe.skipIf(!configured)('SQL Server: project life cycle', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    await t?.close();
  });

  it('lists what is still open: cases, reviews, exports, client links and people', async () => {
    for (const [i, status] of ['fresh', 'assigned', 'finalised'].entries())
      await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status)
        VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${`C${i}`}, '{}', ${status})`.execute(
        t.owner,
      );
    const res = await pm.agent.get(`/api/v1/projects/${project}/closeout`).expect(200);
    expect(res.body).toMatchObject({
      status: 'draft',
      openCases: 2,
      openInterviews: 0,
      pendingReview: 0,
      exportsDone: 0,
      lastExportAt: null,
      activeShareLinks: 0,
      // The project manager's own role in this project.
      projectMembers: 1,
    });
  });

  it('moves through its statuses, each change in the audit log', async () => {
    for (const status of ['active', 'closed', 'archived'])
      await pm.agent
        .patch(`/api/v1/projects/${project}`)
        .set('x-csrf-token', pm.csrf)
        .send({ status })
        .expect(200);
    const got = await pm.agent.get(`/api/v1/projects/${project}`).expect(200);
    expect(got.body.status).toBe('archived');
    const audit = await sql<{ details: string }>`SELECT details FROM audit_log
      WHERE tenant_id = ${tenant.id} AND action = 'project.updated' AND target_id = ${project}
      ORDER BY at`.execute(t.owner);
    expect(audit.rows.map((r) => (JSON.parse(r.details) as { status?: string }).status)).toEqual([
      'active',
      'closed',
      'archived',
    ]);
  });

  it('is for those who configure the project', async () => {
    const sup = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: project }]),
      tenant.slug,
    );
    await sup.agent.get(`/api/v1/projects/${project}/closeout`).expect(403);
  });
});
