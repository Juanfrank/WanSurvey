import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../src/common/crypto.js';
import { resetConfigCache } from '../../src/config.js';
import { auditActions } from './harness.js';
import {
  PASSWORD,
  bootstrap,
  configured,
  createTenant,
  createUser,
  type MssqlTestApp,
} from './harness.js';

/**
 * What is left of test/auth.test.ts on SQL Server: second-factor enrolment and its gate, a cookie
 * with another organisation's id, and the public endpoints. Login, sessions, brute force and the
 * account lifecycle are in auth-http and account-lifecycle-http.
 */
describe.skipIf(!configured)('SQL Server: enrolment and public endpoints', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('owners and admins must enrol TOTP before doing anything else', async () => {
    const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }], { totp: false });
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
    const stored = (
      (await sql<{
        totp_secret_enc: string;
      }>`SELECT totp_secret_enc FROM users WHERE id = ${admin.id}`.execute(t.owner)) as {
        rows: { totp_secret_enc: string }[];
      }
    ).rows[0]!.totp_secret_enc;
    expect(stored).toMatch(/^v1\./); // encrypted at rest
    expect(stored).not.toContain(setup.body.secret);

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
    expect(await auditActions(t.owner, tenant.id)).toContain('auth.mfa_enabled');
  });

  it('enrolled users must enter a code at every login, and wrong codes are audited', async () => {
    const owner = await createUser(t.owner, tenant.id, [{ role: 'owner' }]);
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
    await sql`UPDATE users SET totp_last_step = NULL WHERE id = ${owner.id}`.execute(t.owner);
    expect(
      (
        await agent
          .post('/api/v1/auth/2fa/verify')
          .set('x-csrf-token', csrf)
          .send({ code: totp(owner.totpSecret!) })
      ).status,
    ).toBe(204);
    expect((await agent.get('/api/v1/tenant')).status).toBe(200);
    expect(await auditActions(t.owner, tenant.id)).toEqual(
      expect.arrayContaining(['auth.mfa_failed', 'auth.mfa_verified']),
    );
  });

  it('the per-role policy is gone: the setting is refused, the rule is the server’s', async () => {
    const org = await createTenant(t.owner);
    const owner = await createUser(t.owner, org.id, [{ role: 'owner' }]);
    const agent = request.agent(t.app.getHttpServer());
    const csrf = (
      await agent.post('/api/v1/auth/login').send({ email: owner.email, password: PASSWORD })
    ).body.csrfToken as string;
    await agent
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', csrf)
      .send({ code: totp(owner.totpSecret!) })
      .expect(204);
    await agent
      .patch('/api/v1/tenant')
      .set('x-csrf-token', csrf)
      .send({ settings: { twoFactorRoles: ['supervisor'] } })
      .expect(400);
    // Relaxed here (PASSWORD_2FA_REQUIRED=false, tests only): owners and admins only.
    expect((await http().get('/api/v1/auth/methods')).body.passwordTwoStep).toBe('admins');
    const signIn = async (role: 'supervisor' | 'admin') => {
      const u = await createUser(t.owner, org.id, [{ role }], { totp: false });
      return (await http().post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }))
        .body.mfaState as string;
    };
    expect(await signIn('supervisor')).toBe('ok');
    expect(await signIn('admin')).toBe('enroll');
  });

  it('a forged tenant id in the cookie finds no session', async () => {
    const other = await createTenant(t.owner);
    const user = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
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

  it('health and OpenAPI are public', async () => {
    expect((await http().get('/health')).body).toEqual({ status: 'ok', db: true });
    const doc = await http().get('/docs/openapi.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/auth/login');
  });
});

/**
 * The rule as production runs it (PASSWORD_2FA_REQUIRED, default true): every account that signs
 * in with a password sets up a second factor before anything else, whatever its role.
 */
describe.skipIf(!configured)('SQL Server: two-step verification for every password', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    process.env.PASSWORD_2FA_REQUIRED = 'true';
    resetConfigCache();
    t = await bootstrap();
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
    process.env.PASSWORD_2FA_REQUIRED = 'false';
    resetConfigCache();
  });

  it('asks every role to enrol at a password sign-in, and lets them in once enrolled', async () => {
    expect((await http().get('/api/v1/auth/methods')).body.passwordTwoStep).toBe('everyone');
    for (const role of ['interviewer', 'client_viewer', 'supervisor'] as const) {
      const u = await createUser(t.owner, tenant.id, [{ role }], { totp: false });
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: u.email, password: PASSWORD });
      expect(res.body.mfaState, role).toBe('enroll');
    }
    const u = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }], { totp: false });
    const agent = request.agent(t.app.getHttpServer());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: PASSWORD });
    const csrf = login.body.csrfToken as string;
    const blocked = await agent.get('/api/v1/projects');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const setup = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf);
    expect(setup.status).toBe(200);
    await agent
      .post('/api/v1/auth/2fa/enable')
      .set('x-csrf-token', csrf)
      .send({ code: totp(setup.body.secret) })
      .expect(204);
    expect((await agent.get('/api/v1/projects')).status).toBe(200);
    // The next sign-in asks for the code, as for anyone enrolled.
    const again = await http()
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: PASSWORD });
    expect(again.body.mfaState).toBe('pending');
  });

  it('the people list says who must still set it up: password accounts only', async () => {
    const admin = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
    const without = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }], {
      totp: false,
    });
    const ssoOnly = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }], {
      totp: false,
    });
    await sql`UPDATE users SET password_hash = NULL WHERE id = ${ssoOnly.id}`.execute(t.owner);
    const agent = request.agent(t.app.getHttpServer());
    const csrf = (
      await agent.post('/api/v1/auth/login').send({ email: admin.email, password: PASSWORD })
    ).body.csrfToken as string;
    await sql`UPDATE users SET totp_last_step = NULL WHERE id = ${admin.id}`.execute(t.owner);
    await agent
      .post('/api/v1/auth/2fa/verify')
      .set('x-csrf-token', csrf)
      .send({ code: totp(admin.totpSecret!) })
      .expect(204);
    const list = (await agent.get('/api/v1/users')).body as {
      id: string;
      twoStepRequired: boolean;
      totpEnabled: boolean;
      hasPassword: boolean;
    }[];
    const row = (id: string) => list.find((m) => m.id === id)!;
    expect(row(without.id)).toMatchObject({ twoStepRequired: true, totpEnabled: false });
    expect(row(ssoOnly.id)).toMatchObject({ twoStepRequired: false, hasPassword: false });
    expect(row(admin.id)).toMatchObject({ twoStepRequired: true, totpEnabled: true });
  });
});
