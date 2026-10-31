import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../src/common/crypto.js';
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
