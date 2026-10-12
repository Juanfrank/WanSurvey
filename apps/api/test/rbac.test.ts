import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ROLES, roleHasPermission, type Permission, type Role } from '@wansurvey/schema';
import { resetConfigCache } from '../src/config.js';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  PASSWORD,
  type Session,
  type TestApp,
} from './harness.js';

interface Endpoint {
  name: string;
  permission: Permission;
  call(s: Session, ids: { project: string; target: string }): request.Test;
}

/** Every protected endpoint with the permission it requires. */
const ENDPOINTS: Endpoint[] = [
  { name: 'GET /users', permission: 'users.read', call: (s) => s.agent.get('/api/v1/users') },
  {
    name: 'POST /users/invite',
    permission: 'users.manage',
    call: (s) =>
      s.agent
        .post('/api/v1/users/invite')
        .set('x-csrf-token', s.csrf)
        .send({
          email: `inv-${Math.random().toString(36).slice(2)}@example.org`,
          name: 'X',
          memberships: [{ role: 'client_viewer' }],
        }),
  },
  {
    name: 'PUT /users/:id/memberships',
    permission: 'users.manage',
    call: (s, ids) =>
      s.agent
        .put(`/api/v1/users/${ids.target}/memberships`)
        .set('x-csrf-token', s.csrf)
        .send({ memberships: [{ role: 'client_viewer' }] }),
  },
  {
    name: 'POST /users/:id/force-logout',
    permission: 'users.manage',
    call: (s, ids) =>
      s.agent.post(`/api/v1/users/${ids.target}/force-logout`).set('x-csrf-token', s.csrf),
  },
  { name: 'GET /tenant', permission: 'tenant.read', call: (s) => s.agent.get('/api/v1/tenant') },
  {
    name: 'PATCH /tenant',
    permission: 'tenant.manage',
    call: (s) =>
      s.agent
        .patch('/api/v1/tenant')
        .set('x-csrf-token', s.csrf)
        .send({ settings: { touched: true } }),
  },
  {
    name: 'GET /projects',
    permission: 'projects.read',
    call: (s) => s.agent.get('/api/v1/projects'),
  },
  {
    name: 'POST /projects',
    permission: 'projects.create',
    call: (s) =>
      s.agent
        .post('/api/v1/projects')
        .set('x-csrf-token', s.csrf)
        .send({ name: 'P', code: `C${Math.random().toString(36).slice(2, 10)}` }),
  },
  {
    name: 'GET /projects/:id',
    permission: 'projects.read',
    call: (s, ids) => s.agent.get(`/api/v1/projects/${ids.project}`),
  },
  {
    name: 'PATCH /projects/:id',
    permission: 'projects.update',
    call: (s, ids) =>
      s.agent
        .patch(`/api/v1/projects/${ids.project}`)
        .set('x-csrf-token', s.csrf)
        .send({ timezone: 'America/Lima' }),
  },
  {
    name: 'GET /audit-log',
    permission: 'audit.read',
    call: (s) => s.agent.get('/api/v1/audit-log'),
  },
];

describe('role-based access control', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let otherProject: string;
  const sessions = new Map<Role, Session>();

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    otherProject = await createProject(t.admin, tenant.id);
    for (const role of ROLES) {
      const user = await createUser(t.admin, tenant.id, [{ role }]);
      sessions.set(role, await login(t.app, user));
    }
  });
  afterAll(() => t.close());

  const cases = ROLES.flatMap((role) => ENDPOINTS.map((e) => ({ role, endpoint: e })));

  it.each(cases)('$role → $endpoint.name', async ({ role, endpoint }) => {
    const target = await createUser(t.admin, tenant.id, [{ role: 'client_viewer' }]);
    const res = await endpoint.call(sessions.get(role)!, { project, target: target.id });
    if (roleHasPermission(role, endpoint.permission)) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('every endpoint requires a session', async () => {
    const anon = { agent: request.agent(t.app.getHttpServer()), csrf: 'x' } as unknown as Session;
    for (const e of ENDPOINTS) {
      const res = await e.call(anon, { project, target: project });
      expect(res.status, e.name).toBe(401);
    }
  });

  describe('project-scoped roles', () => {
    let supervisor: Session;
    let manager: Session;

    beforeAll(async () => {
      supervisor = await login(
        t.app,
        await createUser(t.admin, tenant.id, [{ role: 'supervisor', projectId: project }]),
      );
      manager = await login(
        t.app,
        await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
      );
    });

    it('see and act only within their project', async () => {
      expect((await supervisor.agent.get(`/api/v1/projects/${project}`)).status).toBe(200);
      expect((await supervisor.agent.get(`/api/v1/projects/${otherProject}`)).status).toBe(403);
      const list = await supervisor.agent.get('/api/v1/projects');
      expect(list.body.map((p: { id: string }) => p.id)).toEqual([project]);
      expect(
        (
          await supervisor.agent
            .patch(`/api/v1/projects/${project}`)
            .set('x-csrf-token', supervisor.csrf)
            .send({ timezone: 'UTC' })
        ).status,
      ).toBe(403);

      expect(
        (
          await manager.agent
            .patch(`/api/v1/projects/${project}`)
            .set('x-csrf-token', manager.csrf)
            .send({ timezone: 'UTC' })
        ).status,
      ).toBe(200);
      expect(
        (
          await manager.agent
            .patch(`/api/v1/projects/${otherProject}`)
            .set('x-csrf-token', manager.csrf)
            .send({ timezone: 'UTC' })
        ).status,
      ).toBe(403);
    });

    it('cannot use tenant-level endpoints through a project role', async () => {
      expect(
        (
          await manager.agent
            .post('/api/v1/projects')
            .set('x-csrf-token', manager.csrf)
            .send({ name: 'x', code: 'SCOPED' })
        ).status,
      ).toBe(403);
      expect((await supervisor.agent.get('/api/v1/users')).status).toBe(403);
    });
  });

  it('tenants never see each other through the API', async () => {
    const other = await createTenant(t.admin);
    const otherAdmin = await createUser(t.admin, other.id, [{ role: 'admin' }]);
    const s = await login(t.app, otherAdmin);
    expect((await s.agent.get(`/api/v1/projects/${project}`)).status).toBe(404);
    const users = await s.agent.get('/api/v1/users');
    expect(users.body.map((u: { id: string }) => u.id)).toEqual([otherAdmin.id]);
    const audit = await s.agent.get('/api/v1/audit-log');
    expect(audit.body.every((a: { tenantId: string }) => a.tenantId === other.id)).toBe(true);
  });

  it('admins can filter the audit log', async () => {
    const s = sessions.get('admin')!;
    const res = await s.agent
      .get('/api/v1/audit-log')
      .query({ action: 'project.created', limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((r: { action: string }) => r.action === 'project.created')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('limits login attempts per client', async () => {
    process.env.LOGIN_RATE_LIMIT = '3';
    resetConfigCache();
    const t = await bootstrap();
    try {
      const tenant = await createTenant(t.admin);
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await request(t.app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: PASSWORD });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await t.close();
      process.env.LOGIN_RATE_LIMIT = '1000';
      resetConfigCache();
    }
  });
});
