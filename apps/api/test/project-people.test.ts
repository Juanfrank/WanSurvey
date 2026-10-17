import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
  type TestUser,
} from './harness.js';

/** The people of one project: administrators and the project's manager give roles in it. */
describe('project people', () => {
  let t: TestApp;
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
    tenant = await createTenant(t.admin);
    a = await createProject(t.admin, tenant.id);
    b = await createProject(t.admin, tenant.id);
    admin = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'admin' }]));
    managerUser = await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: a }]);
    manager = await login(t.app, managerUser);
    interviewer = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: a }]),
    );
    ana = await createUser(t.admin, tenant.id, [{ role: 'client_viewer' }]);
    boss = await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]);
  });
  afterAll(() => t.close());

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
    const audit =
      await t.admin`select details from audit_log where action = 'user.role_changed' and target_id = ${ana.id}`;
    expect(audit.at(-1)!.details).toMatchObject({ projectId: a, after: 'reviewer' });
  });

  it("the project's manager gives roles from supervisor down, only in their project", async () => {
    const view = await manager.agent.get(`/api/v1/projects/${a}/people`).expect(200);
    expect(view.body.grantable).toEqual([
      'supervisor',
      'reviewer',
      'interviewer',
      'data_entry',
      'client_viewer',
    ]);
    expect((await put(manager, a, ana.id, 'interviewer')).status).toBe(200);
    expect((await put(manager, a, ana.id, 'project_manager')).status).toBe(403);
    // Not in another project, not on someone above supervisor, not on themselves.
    expect((await put(manager, b, ana.id, 'interviewer')).status).toBe(403);
    expect((await put(manager, a, boss.id, 'interviewer')).status).toBe(403);
    expect((await put(manager, a, managerUser.id, 'supervisor')).status).toBe(403);
    // Removing touches only this project's roles.
    await put(admin, b, ana.id, 'interviewer').expect(200);
    expect((await put(manager, a, ana.id, null)).status).toBe(200);
    const left =
      await t.admin`select role, project_id from memberships where user_id = ${ana.id} order by role`;
    expect(left.map((g) => [g.role, g.project_id])).toEqual([
      ['client_viewer', null],
      ['interviewer', b],
    ]);
  });

  it('others neither see nor change the people of a project', async () => {
    await interviewer.agent.get(`/api/v1/projects/${a}/people`).expect(403);
    expect((await put(interviewer, a, ana.id, 'interviewer')).status).toBe(403);
  });
});
