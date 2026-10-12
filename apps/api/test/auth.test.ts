import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { totp } from '../src/common/crypto.js';
import { bootstrap, createTenant, createUser, login, PASSWORD, type TestApp } from './harness.js';

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
      .send({ tenant: tenant.slug, email: user.email.toUpperCase(), password: PASSWORD });
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
      .send({ tenant: tenant.slug, email: user.email, password: 'wrong password!' });
    const noTenant = await http()
      .post('/api/v1/auth/login')
      .send({ tenant: 'nope', email: user.email, password: PASSWORD });
    const noUser = await http()
      .post('/api/v1/auth/login')
      .send({ tenant: tenant.slug, email: 'x@example.org', password: PASSWORD });
    for (const r of [bad, noTenant, noUser]) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    expect(await auditActions(user.id)).toContain('auth.login_failed');
  });

  it('requires a session on protected routes and CSRF on writes', async () => {
    expect((await http().get('/api/v1/auth/me')).status).toBe(401);
    const user = await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]);
    const s = await login(t.app, tenant.slug, user);
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
    const s = await login(t.app, tenant.slug, user);
    expect((await s.agent.post('/api/v1/auth/logout').set('x-csrf-token', s.csrf)).status).toBe(
      204,
    );
    expect((await s.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    const s = await login(t.app, tenant.slug, user);
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
      .send({ tenant: tenant.slug, email: user.email, password: PASSWORD });
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
        .send({ tenant: tenant.slug, email: admin.email, password: PASSWORD });
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
        .send({ tenant: tenant.slug, email: owner.email, password: PASSWORD });
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
      const s = await login(t.app, tenant.slug, admin);
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
      expect(token.startsWith(tenant.id)).toBe(true);
      const stored = (
        await t.admin`select token_hash from user_tokens where user_id = ${inv.body.id}`
      )[0]!;
      expect(stored.token_hash).not.toContain(token.split('.')[1]); // only the hash is stored

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
      await login(t.app, tenant.slug, { id: inv.body.id, email, totpSecret: null });
    });

    it('password reset revokes existing sessions', async () => {
      const user = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      const s = await login(t.app, tenant.slug, user);
      expect(
        (
          await http()
            .post('/api/v1/auth/password/forgot')
            .send({ tenant: tenant.slug, email: 'nobody@example.org' })
        ).status,
      ).toBe(204);
      expect(
        (
          await http()
            .post('/api/v1/auth/password/forgot')
            .send({ tenant: tenant.slug, email: user.email })
        ).status,
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
        .send({ tenant: tenant.slug, email: user.email, password: 'a brand new passphrase' });
      expect(relog.status).toBe(200);
    });

    it('deactivation and forced logout', async () => {
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const a = await login(t.app, tenant.slug, admin);
      const victim = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
      const v = await login(t.app, tenant.slug, victim);

      expect(
        (await a.agent.post(`/api/v1/users/${victim.id}/force-logout`).set('x-csrf-token', a.csrf))
          .status,
      ).toBe(204);
      expect((await v.agent.get('/api/v1/auth/me')).status).toBe(401);

      const v2 = await login(t.app, tenant.slug, victim);
      expect(
        (await a.agent.post(`/api/v1/users/${victim.id}/deactivate`).set('x-csrf-token', a.csrf))
          .status,
      ).toBe(204);
      expect((await v2.agent.get('/api/v1/auth/me')).status).toBe(401);
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ tenant: tenant.slug, email: victim.email, password: PASSWORD });
      expect(res.status).toBe(401);
      const row = (
        await t.admin`select status, deactivated_at from users where id = ${victim.id}`
      )[0]!;
      expect(row.status).toBe('deactivated'); // kept for attribution
      expect(await auditActions(victim.id)).toEqual(
        expect.arrayContaining(['user.forced_logout', 'user.deactivated']),
      );
    });

    it('role changes follow rank rules and are audited', async () => {
      const admin = await createUser(t.admin, tenant.id, [{ role: 'admin' }]);
      const a = await login(t.app, tenant.slug, admin);
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

  it('health and OpenAPI are public', async () => {
    expect((await http().get('/health')).body).toEqual({ status: 'ok', db: true });
    const doc = await http().get('/docs/openapi.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/auth/login');
  });
});
