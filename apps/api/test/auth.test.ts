import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { totp } from '../src/common/crypto.js';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  PASSWORD,
  type TestApp,
} from './harness.js';

describe('authentication', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
  });
  afterAll(() => t.close());

  const auditActions = async (userId: string) =>
    (
      await t.admin`select action from audit_log where tenant_id = ${tenant.id} and (actor_user_id = ${userId} or target_id = ${userId}) order by at, id`
    ).map((r) => r.action as string);

  it('logs in with an httpOnly session cookie and a CSRF token', async () => {
    const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mfaState).toBe('ok');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.find((c) => c.startsWith('ws_sid='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('ws_csrf='))).not.toMatch(/HttpOnly/);
    expect(await auditActions(user.id)).toContain('auth.login');
  });

  it('rejects bad credentials uniformly and audits the failure', async () => {
    const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    const bad = await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'wrong password!' });
    const noUser = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'x@example.org', password: PASSWORD });
    for (const r of [bad, noUser]) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    expect(await auditActions(user.id)).toContain('auth.login_failed');
    // Correct password, organisation the person does not belong to.
    const notMember = await http()
      .post('/api/v1/auth/login')
      .send({ tenant: 'nope', email: user.email, password: PASSWORD });
    expect(notMember.status).toBe(403);
    expect(notMember.body.code).toBe('NOT_A_MEMBER');
  });

  it('requires a session on protected routes and CSRF on writes', async () => {
    expect((await http().get('/api/v1/auth/me')).status).toBe(401);
    const user = await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]);
    const s = await login(t.app, user);
    expect((await s.agent.get('/api/v1/auth/me')).status).toBe(200);
    const noCsrf = await s.agent.post('/api/v1/projects').send({ name: 'P', code: 'NOCSRF' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF');
    const ok = await s.agent
      .post('/api/v1/projects')
      .set('x-csrf-token', s.csrf)
      .send({ name: 'P', code: 'WITHCSRF' });
    expect(ok.status).toBe(201);
  });

  it('logout revokes the session', async () => {
    const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    const s = await login(t.app, user);
    expect((await s.agent.post('/api/v1/auth/logout').set('x-csrf-token', s.csrf)).status).toBe(
      204,
    );
    expect((await s.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    const s = await login(t.app, user);
    await t.admin`update sessions set last_seen_at = now() - interval '2 hours' where user_id = ${user.id}`;
    const res = await s.agent.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
  });

  it('a forged tenant id in the cookie finds no session', async () => {
    const other = await createTenant(t.admin);
    const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    const sid = (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('ws_sid='))!
      .split(';')[0]!
      .slice(7);
    const forged = `${other.id}.${decodeURIComponent(sid).split('.').slice(1).join('.')}`;
    expect((await http().get('/api/v1/auth/me').set('Cookie', `ws_sid=${forged}`)).status).toBe(
      401,
    );
  });

  describe('two-factor authentication', () => {
    it('owners and admins must enrol TOTP before doing anything else', async () => {
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }], { totp: false });
      const agent = request.agent(t.app.getHttpServer());
      const res = await agent
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: PASSWORD });
      expect(res.body.mfaState).toBe('enroll');
      const csrf = res.body.csrfToken;
      const blocked = await agent.get('/api/v1/users');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

      const setup = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf);
      expect(setup.status).toBe(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const { totp_secret_enc } = (
        await t.admin`select totp_secret_enc from users where id = ${admin.id}`
      )[0]!;
      expect(totp_secret_enc).toMatch(/^v1\./); // encrypted at rest
      expect(totp_secret_enc).not.toContain(setup.body.secret);

      expect(
        (
          await agent
            .post('/api/v1/auth/2fa/enable')
            .set('x-csrf-token', csrf)
            .send({ code: '000000' })
        ).status,
      ).toBe(401);
      expect(
        (
          await agent
            .post('/api/v1/auth/2fa/enable')
            .set('x-csrf-token', csrf)
            .send({ code: totp(setup.body.secret) })
        ).status,
      ).toBe(204);
      expect((await agent.get('/api/v1/users')).status).toBe(200);
      expect(await auditActions(admin.id)).toContain('auth.mfa_enabled');
    });

    it('enrolled users must enter a code at every login', async () => {
      const owner = await createUser(t.admin, tenant.id, [{ role: 'owner' }]);
      const agent = request.agent(t.app.getHttpServer());
      const res = await agent
        .post('/api/v1/auth/login')
        .send({ email: owner.email, password: PASSWORD });
      expect(res.body.mfaState).toBe('pending');
      const csrf = res.body.csrfToken;
      const blocked = await agent.get('/api/v1/tenant');
      expect(blocked.body.code).toBe('MFA_REQUIRED');
      expect(
        (
          await agent
            .post('/api/v1/auth/2fa/verify')
            .set('x-csrf-token', csrf)
            .send({ code: '123456' })
        ).status,
      ).toBe(401);
      expect(
        (
          await agent
            .post('/api/v1/auth/2fa/verify')
            .set('x-csrf-token', csrf)
            .send({ code: totp(owner.totpSecret!) })
        ).status,
      ).toBe(204);
      expect((await agent.get('/api/v1/tenant')).status).toBe(200);
      expect(await auditActions(owner.id)).toEqual(
        expect.arrayContaining(['auth.mfa_failed', 'auth.mfa_verified']),
      );
    });
  });

  describe('account lifecycle', () => {
    it('invitation → accept → login', async () => {
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const s = await login(t.app, admin);
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
        await t.admin`select token_hash from user_tokens where user_id = ${inv.body.id}`
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
      await login(t.app, { id: inv.body.id, email, totpSecret: null });
    });

    it('password reset revokes existing sessions', async () => {
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      const s = await login(t.app, user);
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
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const a = await login(t.app, admin);
      const victim = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      const v = await login(t.app, victim);

      expect(
        (await a.agent.post(`/api/v1/users/${victim.id}/force-logout`).set('x-csrf-token', a.csrf))
          .status,
      ).toBe(204);
      expect((await v.agent.get('/api/v1/auth/me')).status).toBe(401);

      const v2 = await login(t.app, victim);
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
        await t.admin`select status, deactivated_at from tenant_members where user_id = ${victim.id} and tenant_id = ${tenant.id}`
      )[0]!;
      expect(row.status).toBe('deactivated'); // kept for attribution
      expect(await auditActions(victim.id)).toEqual(
        expect.arrayContaining(['user.forced_logout', 'user.deactivated']),
      );
    });

    it('a lost invitation is sent again; a deactivated member is let back in', async () => {
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const a = await login(t.app, admin);
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
      await login(t.app, { id: inv.body.id, email, totpSecret: null });
      expect((await post(`/users/${inv.body.id}/reactivate`)).body.code).toBe('NOT_DEACTIVATED');
      expect(await auditActions(inv.body.id)).toEqual(
        expect.arrayContaining(['user.invitation_resent', 'user.reactivated']),
      );
    });

    it('role changes follow rank rules and are audited', async () => {
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const a = await login(t.app, admin);
      const target = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      const put = (id: string, memberships: unknown) =>
        a.agent
          .put(`/api/v1/users/${id}/memberships`)
          .set('x-csrf-token', a.csrf)
          .send({ memberships });

      expect((await put(target.id, [{ role: 'owner' }])).status).toBe(403);
      expect((await put(admin.id, [{ role: 'interviewer' }])).status).toBe(403); // not yourself
      const owner = await createUser(t.admin, tenant.id, [{ role: 'owner' }]);
      expect((await put(owner.id, [{ role: 'interviewer' }])).status).toBe(403); // cannot demote an owner
      const ok = await put(target.id, [{ role: 'supervisor' }]);
      expect(ok.status).toBe(200);
      const log = (
        await t.admin`select details from audit_log where action = 'user.role_changed' and target_id = ${target.id}`
      )[0]!;
      expect(log.details).toMatchObject({
        before: [{ role: 'interviewer' }],
        after: [{ role: 'supervisor' }],
      });
    });
  });

  describe('accounts in several organisations', () => {
    it('logs in with e-mail only, lists organisations and switches between them', async () => {
      const other = await createTenant(t.admin);
      const pA = await createProject(t.admin, tenant.id);
      const pB = await createProject(t.admin, other.id);
      const user = await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]);
      await createUser(t.admin, other.id, [{ role: 'supervisor' }], { existing: user });

      // Explicit organisation, then the last-used one is the default.
      const first = await login(t.app, user, other.slug);
      expect(first.tenantId).toBe(other.id);
      const s = await login(t.app, user);
      expect(s.tenantId).toBe(other.id);

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
      expect(me.body.memberships).toEqual([{ role: 'project_manager', projectId: null }]);

      const stranger = await createTenant(t.admin);
      const denied = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', switched.csrf)
        .send({ tenantId: stranger.id });
      expect(denied.status).toBe(403);
    });

    it('2FA verified once carries over when switching organisation', async () => {
      const other = await createTenant(t.admin);
      const owner = await createUser(t.admin, tenant.id, [{ role: 'owner' }]);
      await createUser(t.admin, other.id, [{ role: 'admin' }], { existing: owner });
      const s = await login(t.app, owner, tenant.slug);
      const sw = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', s.csrf)
        .send({ tenantId: other.id });
      expect(sw.body.mfaState).toBe('ok');
      expect((await s.agent.get('/api/v1/users')).status).toBe(200);
    });

    it('deactivation in one organisation leaves the others usable', async () => {
      const other = await createTenant(t.admin);
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const a = await login(t.app, admin, tenant.slug);
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      await createUser(t.admin, other.id, [{ role: 'interviewer' }], { existing: user });
      const inA = await login(t.app, user, tenant.slug);
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
      const other = await createTenant(t.admin);
      const admin = await createUser(t.admin, other.id, [{ role: 'admin' }]);
      const a = await login(t.app, admin, other.slug);
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
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
      const s = await login(t.app, user, other.slug);
      expect(s.tenantId).toBe(other.id);
    });

    it('an e-mail belongs to one account across organisations', async () => {
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      await expect(
        createUser(t.admin, tenant.id, [], { email: user.email.toUpperCase() }),
      ).rejects.toThrow(/users_email_uq/);
    });

    it('a password reset ends sessions in every organisation', async () => {
      const other = await createTenant(t.admin);
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      await createUser(t.admin, other.id, [{ role: 'interviewer' }], { existing: user });
      const inA = await login(t.app, user, tenant.slug);
      const inB = await login(t.app, user, other.slug);
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
        const rows =
          await t.admin`select 1 from audit_log where tenant_id = ${tid} and action = 'auth.password_reset' and target_id = ${user.id}`;
        expect(rows).toHaveLength(1);
      }
    });
  });

  it('health and OpenAPI are public', async () => {
    expect((await http().get('/health')).body).toEqual({ status: 'ok', db: true });
    const doc = await http().get('/docs/openapi.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/auth/login');
  });
});
