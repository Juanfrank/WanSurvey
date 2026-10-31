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
  type TestUser,
} from './harness.js';

/** The people of one project: administrators and the project's manager give roles in it. */
describe.skipIf(!configured)('SQL Server: project people', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let a: string;
  let b: string;
  let admin: Session;
  let manager: Session;
  let managerUser: TestUser;
  let interviewer: Session;
  let ana: TestUser;
  let boss: TestUser;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    a = await createProject(t.owner, tenant.id);
    b = await createProject(t.owner, tenant.id);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]), tenant.slug);
    managerUser = await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: a }]);
    manager = await login(t, managerUser, tenant.slug);
    interviewer = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: a }]),
      tenant.slug,
    );
    ana = await createUser(t.owner, tenant.id, [{ role: 'client_viewer' }]);
    boss = await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]);
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  const put = (s: Session, project: string, userId: string, role: string | null) =>
    s.agent
      .put(`/api/v1/projects/${project}/people/${userId}`)
      .set('x-csrf-token', s.csrf)
      .send({ role });

  it('an administrator gives a role in one project; organisation roles stay', async () => {
    const res = await put(admin, a, ana.id, 'reviewer');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = await admin.agent.get(`/api/v1/projects/${a}/people`).expect(200);
    expect(view.body.canManage).toBe(true);
    expect(view.body.members.find((m: { userId: string }) => m.userId === ana.id)).toMatchObject({
      role: 'reviewer',
      orgRole: 'client_viewer',
    });
    const audit = await rows(
      sql`SELECT details FROM audit_log WHERE action = 'user.role_changed' AND target_id = ${ana.id} ORDER BY at, id`,
    );
    expect(JSON.parse(audit.at(-1)!.details as string)).toMatchObject({
      projectId: a,
      after: 'reviewer',
    });
  });

  it("the project's manager gives roles from supervisor down, only in their project", async () => {
    const view = await manager.agent.get(`/api/v1/projects/${a}/people`).expect(200);
    expect(view.body.grantable).toEqual(['supervisor', 'reviewer', 'interviewer', 'client_viewer']);
    expect((await put(manager, a, ana.id, 'interviewer')).status).toBe(200);
    expect((await put(manager, a, ana.id, 'project_manager')).status).toBe(403);
    // Not in another project, not on someone above supervisor, not on themselves.
    expect((await put(manager, b, ana.id, 'interviewer')).status).toBe(403);
    expect((await put(manager, a, boss.id, 'interviewer')).status).toBe(403);
    expect((await put(manager, a, managerUser.id, 'supervisor')).status).toBe(403);
    // Removing touches only this project's roles.
    await put(admin, b, ana.id, 'interviewer').expect(200);
    expect((await put(manager, a, ana.id, null)).status).toBe(200);
    const left = await rows(
      sql`SELECT role, project_id FROM memberships WHERE user_id = ${ana.id} ORDER BY role`,
    );
    expect(
      left.map((g) => [g.role, g.project_id ? (g.project_id as string).toLowerCase() : null]),
    ).toEqual([
      ['client_viewer', null],
      ['interviewer', b],
    ]);
  });

  it('others neither see nor change the people of a project', async () => {
    await interviewer.agent.get(`/api/v1/projects/${a}/people`).expect(403);
    expect((await put(interviewer, a, ana.id, 'interviewer')).status).toBe(403);
  });
});
