import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  createTenant,
  createUser,
  login,
  unique,
  type Session,
  type TestApp,
  type TestUser,
} from './harness.js';

/** Administration: teams of people, and the organisation's defaults for new projects. */
describe('administration', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let admin: Session;
  let pm: Session;
  let ana: TestUser;
  let luis: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    admin = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'admin' }]));
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    ana = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    luis = await createUser(t.admin, tenant.id, [{ role: 'supervisor' }]);
    outsider = await createUser(t.admin, (await createTenant(t.admin)).id, [
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
    expect(list.body[0]).toMatchObject({ name: 'Cuadrilla Norte', leaderId: luis.id });
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
});
