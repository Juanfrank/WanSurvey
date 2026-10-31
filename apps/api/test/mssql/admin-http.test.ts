import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrap,
  configured,
  createTenant,
  createUser,
  login,
  unique,
  type Session,
  type MssqlTestApp,
  type TestUser,
} from './harness.js';

/** Administration: teams of people, and the organisation's defaults for new projects. */
describe.skipIf(!configured)('SQL Server: administration', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let admin: Session;
  let pm: Session;
  let ana: TestUser;
  let luis: TestUser;
  let outsider: TestUser;
  let reviewer: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]));
    pm = await login(t, await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]));
    ana = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    luis = await createUser(t.owner, tenant.id, [{ role: 'supervisor' }]);
    reviewer = await login(t, await createUser(t.owner, tenant.id, [{ role: 'reviewer' }]));
    outsider = await createUser(t.owner, (await createTenant(t.owner)).id, [
      { role: 'interviewer' },
    ]);
  });
  afterAll(() => t.close());

  const send = (s: Session, method: 'post' | 'patch' | 'delete', path: string, body = {}) =>
    s.agent[method](`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);

  it('makes teams of people of the organisation, with a leader who is also a member', async () => {
    // Project managers see the people and teams, but do not change them.
    expect((await send(pm, 'post', '/teams', { name: 'Cuadrilla Norte' })).status).toBe(403);
    expect(
      (await send(admin, 'post', '/teams', { name: 'Cuadrilla Norte', memberIds: [outsider.id] }))
        .body.code,
    ).toBe('NOT_A_MEMBER');
    const made = await send(admin, 'post', '/teams', {
      name: 'Cuadrilla Norte',
      leaderId: luis.id,
      memberIds: [ana.id],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await send(admin, 'post', '/teams', { name: 'Cuadrilla Norte' })).status).toBe(409);

    const list = await pm.agent.get('/api/v1/teams').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Cuadrilla Norte' });
    expect(list.body[0].leaderId.toLowerCase()).toBe(luis.id);
    expect(list.body[0].members.map((m: { userId: string }) => m.userId).sort()).toEqual(
      [ana.id, luis.id].sort(),
    );

    await send(admin, 'patch', `/teams/${made.body.id}`, {
      name: 'Cuadrilla Sur',
      memberIds: [],
    }).expect(200);
    const after = (await pm.agent.get('/api/v1/teams')).body[0];
    // The leader stays a member.
    expect(after).toMatchObject({ name: 'Cuadrilla Sur', leaderName: expect.any(String) });
    expect(after.members).toHaveLength(1);
    await send(admin, 'delete', `/teams/${made.body.id}`).expect(200);
    expect((await pm.agent.get('/api/v1/teams')).body).toHaveLength(0);
  });

  it('keeps defaults for new projects and checks them', async () => {
    expect(
      (await send(admin, 'patch', '/tenant', { settings: { defaultTimezone: 'Mars/Base' } }))
        .status,
    ).toBe(400);
    const ok = await send(admin, 'patch', '/tenant', {
      name: 'Demo Research SAC',
      settings: { defaultLanguage: 'en', defaultTimezone: 'America/Lima' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // A later change keeps the other key.
    await send(admin, 'patch', '/tenant', { settings: { defaultLanguage: 'es' } }).expect(200);
    const org = await admin.agent.get('/api/v1/tenant').expect(200);
    expect(org.body).toMatchObject({
      name: 'Demo Research SAC',
      settings: { defaultLanguage: 'es', defaultTimezone: 'America/Lima' },
    });
    const p = await send(admin, 'post', '/projects', { name: 'Nuevo', code: unique('N') });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ timezone: 'America/Lima', languages: ['es'] });
  });

  it('changes what a role may do in the whole organisation, at once and with a way back', async () => {
    const put = (s: Session, overrides: object) =>
      s.agent.put('/api/v1/tenant/roles').set('x-csrf-token', s.csrf).send({ overrides });
    const view = await pm.agent.get('/api/v1/tenant/roles').expect(200);
    const rev = view.body.roles.find((r: { role: string }) => r.role === 'reviewer');
    expect(rev).toMatchObject({ editable: true, changed: false });
    expect(view.body.roles.find((r: { role: string }) => r.role === 'admin').editable).toBe(false);
    expect(view.body.roles.map((r: { role: string }) => r.role)).not.toContain('data_entry');

    // Only those who run the organisation change it; running it is never given away.
    expect((await put(pm, { reviewer: ['users.read'] })).status).toBe(403);
    expect((await put(admin, { reviewer: ['tenant.manage'] })).status).toBe(400);

    await reviewer.agent.get('/api/v1/users').expect(403);
    const saved = await put(admin, { reviewer: [...rev.permissions, 'users.read'] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.roles.find((r: { role: string }) => r.role === 'reviewer').changed).toBe(
      true,
    );
    // Takes effect on the next request of every session.
    await reviewer.agent.get('/api/v1/users').expect(200);
    expect((await reviewer.agent.get('/api/v1/auth/me')).body.permissions).toContain('users.read');

    await put(admin, {}).expect(200);
    await reviewer.agent.get('/api/v1/users').expect(403);
    const audit = await sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ${tenant.id} AND action = 'tenant.roles_updated'`.execute(
      t.owner,
    );
    expect(Number(audit.rows[0]!.n)).toBe(2);
  });
});
