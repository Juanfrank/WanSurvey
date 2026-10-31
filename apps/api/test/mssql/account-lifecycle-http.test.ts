import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
} from './harness.js';

/** Invitations, password reset, deactivation, roles and accounts in several organisations over HTTP on SQL Server (test/auth.test.ts). */
describe.skipIf(!configured)('SQL Server: account lifecycle over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  const http = () => request(t.app.getHttpServer());
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  const auditActions = async (userId: string) =>
    (
      await rows(
        sql`SELECT action FROM audit_log WHERE tenant_id = ${tenant.id} AND (actor_user_id = ${userId} OR target_id = ${userId}) ORDER BY at, id`,
      )
    ).map((r) => r.action as string);

  describe('account lifecycle', () => {
    it('invitation → accept → login', async () => {
      const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
      const s = await login(t, admin, tenant.slug);
      const email = `new-${Date.now()}@example.org`;
      const inv = await s.agent
        .post('/api/v1/users/invite')
        .set('x-csrf-token', s.csrf)
        .send({
          email,
          name: 'New Interviewer',
          firstName: 'Nia',
          memberships: [{ role: 'interviewer' }],
        });
      expect(inv.status).toBe(201);
      const mail = t.mailer.last(email)!;
      const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
      const stored = (
        await rows(sql`SELECT token_hash FROM user_tokens WHERE user_id = ${inv.body.id}`)
      )[0]!;
      expect(stored.token_hash).not.toBe(token); // only the hash is stored
      expect(stored.token_hash).toBe(createHash('sha256').update(token).digest('hex'));

      expect(
        (await http().post('/api/v1/auth/invitations/accept').send({ token, password: 'short' }))
          .status,
      ).toBe(400);
      expect(
        (await http().post('/api/v1/auth/invitations/accept').send({ token, password: PASSWORD }))
          .status,
      ).toBe(204);
      expect(
        (await http().post('/api/v1/auth/invitations/accept').send({ token, password: PASSWORD }))
          .status,
      ).toBe(400); // single use
      await login(t, { id: inv.body.id, email, totpSecret: null }, tenant.slug);
    });

    it('password reset revokes existing sessions', async () => {
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      const s = await login(t, user, tenant.slug);
      expect(
        (await http().post('/api/v1/auth/password/forgot').send({ email: 'nobody@example.org' }))
          .status,
      ).toBe(204);
      expect(
        (await http().post('/api/v1/auth/password/forgot').send({ email: user.email })).status,
      ).toBe(204);
      const token = decodeURIComponent(/token=([^\s]+)/.exec(t.mailer.last(user.email)!.text)![1]!);
      expect(
        (
          await http()
            .post('/api/v1/auth/password/reset')
            .send({ token, password: 'a brand new passphrase' })
        ).status,
      ).toBe(204);
      expect((await s.agent.get('/api/v1/auth/me')).status).toBe(401);
      const relog = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'a brand new passphrase' });
      expect(relog.status).toBe(200);
    });

    it('deactivation and forced logout', async () => {
      const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
      const a = await login(t, admin, tenant.slug);
      const victim = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      const v = await login(t, victim, tenant.slug);

      expect(
        (await a.agent.post(`/api/v1/users/${victim.id}/force-logout`).set('x-csrf-token', a.csrf))
          .status,
      ).toBe(204);
      expect((await v.agent.get('/api/v1/auth/me')).status).toBe(401);

      const v2 = await login(t, victim, tenant.slug);
      expect(
        (await a.agent.post(`/api/v1/users/${victim.id}/deactivate`).set('x-csrf-token', a.csrf))
          .status,
      ).toBe(204);
      expect((await v2.agent.get('/api/v1/auth/me')).status).toBe(401);
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: victim.email, password: PASSWORD });
      expect(res.status).toBe(401);
      const row = (
        await rows(
          sql`SELECT status, deactivated_at FROM tenant_members WHERE user_id = ${victim.id} AND tenant_id = ${tenant.id}`,
        )
      )[0]!;
      expect(row.status).toBe('deactivated'); // kept for attribution
      expect(await auditActions(victim.id)).toEqual(
        expect.arrayContaining(['user.forced_logout', 'user.deactivated']),
      );
    });

    it('a lost invitation is sent again; a deactivated member is let back in', async () => {
      const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
      const a = await login(t, admin, tenant.slug);
      const post = (path: string, body?: object) =>
        a.agent.post(`/api/v1${path}`).set('x-csrf-token', a.csrf).send(body);
      const email = `again-${Date.now()}@example.org`;
      const inv = await post('/users/invite', {
        email,
        name: 'Rita Resend',
        memberships: [{ role: 'interviewer' }],
      });
      const tokenOf = () =>
        decodeURIComponent(/token=([^\s]+)/.exec(t.mailer.last(email)!.text)![1]!);
      const first = tokenOf();
      expect((await post(`/users/${inv.body.id}/resend-invitation`)).status).toBe(204);
      const second = tokenOf();
      expect(second).not.toBe(first);
      // The first link no longer works; the new one does.
      expect(
        (
          await http()
            .post('/api/v1/auth/invitations/accept')
            .send({ token: first, password: PASSWORD })
        ).status,
      ).toBe(400);
      expect(
        (
          await http()
            .post('/api/v1/auth/invitations/accept')
            .send({ token: second, password: PASSWORD })
        ).status,
      ).toBe(204);
      expect((await post(`/users/${inv.body.id}/resend-invitation`)).body.code).toBe('NOT_INVITED');

      expect((await post(`/users/${inv.body.id}/deactivate`)).status).toBe(204);
      expect(
        (await http().post('/api/v1/auth/login').send({ email, password: PASSWORD })).status,
      ).toBe(401);
      expect((await post(`/users/${inv.body.id}/reactivate`)).status).toBe(204);
      await login(t, { id: inv.body.id, email, totpSecret: null }, tenant.slug);
      expect((await post(`/users/${inv.body.id}/reactivate`)).body.code).toBe('NOT_DEACTIVATED');
      expect(await auditActions(inv.body.id)).toEqual(
        expect.arrayContaining(['user.invitation_resent', 'user.reactivated']),
      );
    });

    it('role changes follow rank rules and are audited', async () => {
      const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
      const a = await login(t, admin, tenant.slug);
      const target = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      const put = (id: string, memberships: unknown) =>
        a.agent
          .put(`/api/v1/users/${id}/memberships`)
          .set('x-csrf-token', a.csrf)
          .send({ memberships });

      expect((await put(target.id, [{ role: 'owner' }])).status).toBe(403);
      expect((await put(admin.id, [{ role: 'interviewer' }])).status).toBe(403); // not yourself
      const owner = await createUser(t.owner, tenant.id, [{ role: 'owner' }]);
      expect((await put(owner.id, [{ role: 'interviewer' }])).status).toBe(403); // cannot demote an owner
      const ok = await put(target.id, [{ role: 'supervisor' }]);
      expect(ok.status).toBe(200);
      const log = (
        await rows(
          sql`SELECT details FROM audit_log WHERE action = 'user.role_changed' AND target_id = ${target.id}`,
        )
      )[0]!;
      expect(JSON.parse(log.details as string)).toMatchObject({
        before: [{ role: 'interviewer' }],
        after: [{ role: 'supervisor' }],
      });
    });
  });

  describe('accounts in several organisations', () => {
    it('logs in with e-mail only, lists organisations and switches between them', async () => {
      const other = await createTenant(t.owner);
      const pA = await createProject(t.owner, tenant.id);
      const pB = await createProject(t.owner, other.id);
      const user = await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]);
      await createUser(t.owner, other.id, [{ role: 'supervisor' }], { existing: user });

      // Explicit organisation, then the last-used one is the default.
      const first = await login(t, user, other.slug);
      expect(first.tenantId.toLowerCase()).toBe(other.id);
      const s = await login(t, user, tenant.slug);
      expect(s.tenantId.toLowerCase()).toBe(other.id);

      const tenants = await s.agent.get('/api/v1/auth/tenants');
      expect(tenants.body.map((x: { id: string }) => x.id).sort()).toEqual(
        [tenant.id, other.id].sort(),
      );
      const projectsIn = async (sess: { agent: typeof s.agent }) =>
        (await sess.agent.get('/api/v1/projects')).body.map((p: { id: string }) => p.id);
      expect(await projectsIn(s)).toEqual([pB]);

      const sw = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', s.csrf)
        .send({ tenantId: tenant.id });
      expect(sw.status).toBe(200);
      expect(sw.body.tenant.id).toBe(tenant.id);
      const switched = { agent: s.agent, csrf: sw.body.csrfToken as string };
      expect(await projectsIn(switched)).toContain(pA);
      expect(await projectsIn(switched)).not.toContain(pB);
      // Roles follow the organisation: project manager here, supervisor there.
      const me = await switched.agent.get('/api/v1/auth/me');
      expect(me.body.memberships).toMatchObject([{ role: 'project_manager', projectId: null }]);

      const stranger = await createTenant(t.owner);
      const denied = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', switched.csrf)
        .send({ tenantId: stranger.id });
      expect(denied.status).toBe(403);
    });

    it('2FA verified once carries over when switching organisation', async () => {
      const other = await createTenant(t.owner);
      const owner = await createUser(t.owner, tenant.id, [{ role: 'owner' }]);
      await createUser(t.owner, other.id, [{ role: 'admin' }], { existing: owner });
      const s = await login(t, owner, tenant.slug);
      const sw = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', s.csrf)
        .send({ tenantId: other.id });
      expect(sw.body.mfaState).toBe('ok');
      expect((await s.agent.get('/api/v1/users')).status).toBe(200);
    });

    it('a session that needed no second factor does not skip it in another organisation', async () => {
      // An interviewer here (no code needed) who is an admin there, never enrolled.
      const other = await createTenant(t.owner);
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      await createUser(t.owner, other.id, [{ role: 'admin' }], { existing: user });
      const s = await login(t, user, tenant.slug);
      const sw = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', s.csrf)
        .send({ tenantId: other.id });
      expect(sw.status).toBe(200);
      expect(sw.body.mfaState).toBe('enroll');
      const blocked = await s.agent.get('/api/v1/users');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('deactivation in one organisation leaves the others usable', async () => {
      const other = await createTenant(t.owner);
      const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
      const a = await login(t, admin, tenant.slug);
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      await createUser(t.owner, other.id, [{ role: 'interviewer' }], { existing: user });
      const inA = await login(t, user, tenant.slug);
      expect(
        (await a.agent.post(`/api/v1/users/${user.id}/deactivate`).set('x-csrf-token', a.csrf))
          .status,
      ).toBe(204);
      expect((await inA.agent.get('/api/v1/auth/me')).status).toBe(401);
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.tenant.id).toBe(other.id);
      expect(res.body.tenants.map((x: { id: string }) => x.id)).toEqual([other.id]);
    });

    it('inviting an existing account links it after confirming the current password', async () => {
      const other = await createTenant(t.owner);
      const admin = await createUser(t.owner, other.id, [{ role: 'admin' }]);
      const a = await login(t, admin, other.slug);
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      const inv = await a.agent
        .post('/api/v1/users/invite')
        .set('x-csrf-token', a.csrf)
        .send({
          email: user.email.toUpperCase(),
          name: 'Ignored',
          memberships: [{ role: 'supervisor' }],
        });
      expect(inv.status).toBe(201);
      expect(inv.body).toMatchObject({ id: user.id, existingAccount: true, status: 'invited' });
      const again = await a.agent
        .post('/api/v1/users/invite')
        .set('x-csrf-token', a.csrf)
        .send({ email: user.email, name: 'x', memberships: [{ role: 'supervisor' }] });
      expect(again.status).toBe(409);

      const token = decodeURIComponent(/token=([^\s]+)/.exec(t.mailer.last(user.email)!.text)![1]!);
      const wrong = await http()
        .post('/api/v1/auth/invitations/accept')
        .send({ token, password: 'not my password' });
      expect(wrong.status).toBe(401);
      expect(
        (await http().post('/api/v1/auth/invitations/accept').send({ token, password: PASSWORD }))
          .status,
      ).toBe(204);
      // Password unchanged, and both organisations are now available.
      const s = await login(t, user, other.slug);
      expect(s.tenantId.toLowerCase()).toBe(other.id);
    });

    it('an e-mail belongs to one account across organisations', async () => {
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      await expect(
        createUser(t.owner, tenant.id, [], { email: user.email.toUpperCase() }),
      ).rejects.toThrow(/users_email_uq|duplicate key/i);
    });

    it('a password reset ends sessions in every organisation', async () => {
      const other = await createTenant(t.owner);
      const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
      await createUser(t.owner, other.id, [{ role: 'interviewer' }], { existing: user });
      const inA = await login(t, user, tenant.slug);
      const inB = await login(t, user, other.slug);
      await http().post('/api/v1/auth/password/forgot').send({ email: user.email });
      const token = decodeURIComponent(/token=([^\s]+)/.exec(t.mailer.last(user.email)!.text)![1]!);
      expect(
        (
          await http()
            .post('/api/v1/auth/password/reset')
            .send({ token, password: 'another long passphrase' })
        ).status,
      ).toBe(204);
      expect((await inA.agent.get('/api/v1/auth/me')).status).toBe(401);
      expect((await inB.agent.get('/api/v1/auth/me')).status).toBe(401);
      for (const tid of [tenant.id, other.id]) {
        const found = await rows(
          sql`SELECT 1 AS x FROM audit_log WHERE tenant_id = ${tid} AND action = 'auth.password_reset' AND target_id = ${user.id}`,
        );
        expect(found).toHaveLength(1);
      }
    });
  });
});
