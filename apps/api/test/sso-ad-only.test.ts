import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptField } from '../src/common/crypto.js';
import { resetConfigCache } from '../src/config.js';
import { bootstrap, createTenant, createUser, type TestApp } from './harness.js';
import { MockEntra } from './mock-entra.js';

const WEB = 'http://localhost:5173';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Production with Microsoft only (PASSWORD_LOGIN=false): one button, the default organisation's
 * sign-in from the deployment's settings, no password route, and sessions bound to the
 * directory that issued them.
 */
describe('Microsoft-only sign-in', () => {
  const entra = new MockEntra();
  const slug = `ad-${Date.now().toString(36)}`;
  const entraTenantId = randomUUID();
  let t: TestApp;
  let org: { id: string; slug: string };

  beforeAll(async () => {
    await entra.start();
    Object.assign(process.env, {
      ENTRA_AUTHORITY_HOST: entra.host,
      PUBLIC_WEB_URL: WEB,
      PASSWORD_LOGIN: 'false',
      SSO_DEFAULT_ORG: slug,
      ENTRA_TENANT_ID: entraTenantId,
      ENTRA_CLIENT_ID: CLIENT_ID,
      ENTRA_CLIENT_SECRET: 'deploy-secret',
      ENTRA_ALLOWED_DOMAINS: 'court.gov',
    });
    resetConfigCache();
    t = await bootstrap();
    org = await createTenant(t.admin, slug);
  });
  afterAll(async () => {
    await t.close();
    await entra.stop();
    for (const k of [
      'ENTRA_AUTHORITY_HOST',
      'PUBLIC_WEB_URL',
      'PASSWORD_LOGIN',
      'SSO_DEFAULT_ORG',
      'ENTRA_TENANT_ID',
      'ENTRA_CLIENT_ID',
      'ENTRA_CLIENT_SECRET',
      'ENTRA_ALLOWED_DOMAINS',
    ])
      delete process.env[k];
    resetConfigCache();
  });

  /** The sign-in button: start with nothing, Microsoft, callback. */
  async function button(
    claims: Record<string, unknown>,
    agent = request.agent(t.app.getHttpServer()),
  ) {
    const start = await agent.get('/api/v1/auth/sso/start');
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location!);
    const p = authorize.searchParams;
    const code = entra.issueCode({
      claims: { nonce: p.get('nonce'), ...claims },
      codeChallenge: p.get('code_challenge')!,
      clientId: p.get('client_id')!,
    });
    const callback = await agent
      .get('/api/v1/auth/sso/callback')
      .query({ code, state: p.get('state') });
    return { agent, authorize, callback };
  }

  it('tells the sign-in page to show the Microsoft button alone', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/auth/methods').expect(200);
    expect(res.body).toEqual({ password: false, microsoftNeedsEmail: false });
  });

  it('refuses every password route', async () => {
    const http = request(t.app.getHttpServer());
    for (const [path, body] of [
      ['/api/v1/auth/login', { email: 'a@court.gov', password: 'whatever-123' }],
      ['/api/v1/auth/password/forgot', { email: 'a@court.gov' }],
      ['/api/v1/auth/password/reset', { token: 'x'.repeat(30), password: 'long-enough-pass' }],
      ['/api/v1/auth/invitations/accept', { token: 'x'.repeat(30), password: 'long-enough-pass' }],
    ] as const) {
      const res = await http.post(path).send(body);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('PASSWORD_LOGIN_DISABLED');
    }
  });

  it('signs in with the button through the deployment’s directory, the same way every morning', async () => {
    const user = await createUser(t.admin, org.id, [{ role: 'interviewer' }], {
      email: `ana.${Date.now()}@court.gov`,
    });
    const claims = { oid: randomUUID(), email: user.email, name: 'Ana', amr: ['pwd', 'mfa'] };
    const first = await button(claims);
    expect(first.authorize.origin + first.authorize.pathname).toBe(
      `${entra.host}/${entraTenantId}/oauth2/v2.0/authorize`,
    );
    expect(first.authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(entra.tokenRequests.at(-1)!.get('client_secret')).toBe('deploy-secret');
    expect(first.callback.headers.location).toBe(`${WEB}/`);
    expect((await first.agent.get('/api/v1/auth/me')).status).toBe(200);
    // Linked on the first sign-in; the next ones take the short path to the same account.
    const ids =
      await t.admin`select count(*)::int as n from user_identities where user_id = ${user.id}`;
    expect(ids[0]!.n).toBe(1);
    const again = await button(claims);
    const me = await again.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.id).toBe(user.id);
    const logins = await t.admin`
      select count(*)::int as n from audit_log where actor_user_id = ${user.id} and action = 'auth.login'`;
    expect(logins[0]!.n).toBe(2);
  });

  it('links an account that also belongs to another organisation (no password to prove it)', async () => {
    const other = await createTenant(t.admin);
    const user = await createUser(t.admin, other.id, [{ role: 'interviewer' }], {
      email: `luis.${Date.now()}@court.gov`,
    });
    await createUser(t.admin, org.id, [{ role: 'interviewer' }], { existing: user });
    const { callback, agent } = await button({
      oid: randomUUID(),
      email: user.email,
      amr: ['mfa'],
    });
    expect(callback.headers.location).toBe(`${WEB}/`);
    expect((await agent.get('/api/v1/auth/me')).body.user.id).toBe(user.id);

    // That session opens the other organisation only through the other one's own directory.
    const csrf = (await agent.get('/api/v1/auth/me')).body.csrfToken as string | undefined;
    const res = await agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', csrf ?? '')
      .send({ tenantId: other.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SSO_REQUIRED');
  });

  it('keeps the deployment’s e-mail domain for the default organisation', async () => {
    const other = await createTenant(t.admin);
    await t.admin`
      insert into tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
      values (${other.id}, ${randomUUID()}, ${CLIENT_ID}, ${encryptField('x', process.env.APP_ENCRYPTION_KEY!)}, false, ${['elsewhere.org']})`;
    const owner = await createUser(t.admin, other.id, [{ role: 'owner' }]);
    // Owners sign in through their organisation's directory here too; the setting is what is tested.
    const res = await t.app
      .get((await import('../src/auth/sso-config.js')).SsoConfigs)
      .deploymentTenantForDomain('court.gov');
    expect(res).toBe(org.id);
    expect(owner.id).toBeTruthy();
  });
});
