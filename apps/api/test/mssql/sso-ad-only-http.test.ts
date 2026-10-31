import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptField } from '../../src/common/crypto.js';
import { loadConfig, resetConfigCache } from '../../src/config.js';
import { ownerQuery } from './fixtures.js';
import {
  bootstrap,
  configured,
  createTenant,
  createUser,
  login,
  PASSWORD,
  type MssqlTestApp,
} from './harness.js';
import { MockEntra } from '../mock-entra.js';

const WEB = 'http://localhost:5173';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Production with Microsoft only (PASSWORD_LOGIN=false): one button, the default organisation's
 * sign-in from the deployment's settings, no password route, and sessions bound to the
 * directory that issued them.
 */
describe.skipIf(!configured)('SQL Server: Microsoft-only sign-in', () => {
  const entra = new MockEntra();
  const slug = `ad-${Date.now().toString(36)}`;
  const entraTenantId = randomUUID();
  let t: MssqlTestApp;
  let q: ReturnType<typeof ownerQuery>;
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
      ENTRA_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
      ENTRA_ALLOWED_DOMAINS: 'court.gov',
    });
    resetConfigCache();
    t = await bootstrap();
    q = ownerQuery(t.owner);
    org = await createTenant(t.owner, slug);
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
      'ENTRA_REDIRECT_URI',
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
    const user = await createUser(t.owner, org.id, [{ role: 'interviewer' }], {
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
    const ids = await q`SELECT COUNT(*) as n FROM user_identities WHERE user_id = ${user.id}`;
    expect(Number(ids[0]!.n)).toBe(1);
    const again = await button(claims);
    const me = await again.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.id).toBe(user.id);
    const logins = await q`
      SELECT COUNT(*) as n from audit_log where actor_user_id = ${user.id} and action = 'auth.login'`;
    expect(Number(logins[0]!.n)).toBe(2);
  });

  it('starts at the default organisation for an e-mail whose domain no organisation claims', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/v1/auth/sso/start')
      .query({ email: `x@unclaimed-${Date.now()}.net` });
    expect(res.headers.location).toContain(`/${entraTenantId}/oauth2/v2.0/authorize`);
  });

  it('invites to sign in with Microsoft, and the sign-in accepts the invitation', async () => {
    const admin = await createUser(t.owner, org.id, [{ role: 'admin' }], {
      email: `admin.${Date.now()}@court.gov`,
    });
    const { agent } = await button({ oid: randomUUID(), email: admin.email, amr: ['mfa'] });
    const csrf = (await agent.get('/api/v1/auth/me').expect(200)).body.csrfToken as string;
    const email = `nuevo.${Date.now()}@court.gov`;
    await agent
      .post('/api/v1/users/invite')
      .set('x-csrf-token', csrf)
      .send({ email, name: 'Nuevo', memberships: [{ role: 'interviewer' }] })
      .expect(201);
    const mail = t.mailer.last(email)!;
    expect(mail.text).toContain('Ingresar con Microsoft');
    expect(mail.text).toContain(`${WEB}/accept-invitation?org=${slug}`);
    expect(mail.text).not.toMatch(/token=|password/i);
    const back = await button({ oid: randomUUID(), email, amr: ['mfa'] });
    expect(back.callback.headers.location).toBe(`${WEB}/`);
    const me = await back.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.memberships).toMatchObject([{ role: 'interviewer' }]);
    const [m] = await q`
      SELECT m.status FROM tenant_members m JOIN users u ON u.id = m.user_id
      WHERE u.email = ${email} AND m.tenant_id = ${org.id}`;
    expect(m!.status).toBe('active');
  });

  it('links an account that also belongs to another organisation (no password to prove it)', async () => {
    const other = await createTenant(t.owner);
    const user = await createUser(t.owner, other.id, [{ role: 'interviewer' }], {
      email: `luis.${Date.now()}@court.gov`,
    });
    await createUser(t.owner, org.id, [{ role: 'interviewer' }], { existing: user });
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
    const other = await createTenant(t.owner);
    await q`
      INSERT INTO tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
      VALUES (${other.id}, ${randomUUID()}, ${CLIENT_ID}, ${encryptField('x', process.env.APP_ENCRYPTION_KEY!)}, 0, ${JSON.stringify(['elsewhere.org'])})`;
    const owner = await createUser(t.owner, other.id, [{ role: 'owner' }]);
    // Owners sign in through their organisation's directory here too; the setting is what is tested.
    const res = await t.app
      .get((await import('../../src/auth/sso-config.js')).SsoConfigs)
      .deploymentTenantForDomain('court.gov');
    expect(res).toBe(org.id);
    expect(owner.id).toBeTruthy();
  });

  it('does not link by e-mail through a directory another organisation runs', async () => {
    // Organisation A runs its own directory and claims a domain nobody else claimed; someone
    // of organisation B has an address there. A's directory can say anything about e-mails.
    const a = await createTenant(t.owner);
    const b = await createTenant(t.owner);
    const victim = await createUser(t.owner, b.id, [{ role: 'interviewer' }], {
      email: `victim.${Date.now()}@unclaimed.net`,
    });
    const directory = randomUUID();
    await q`
      INSERT INTO tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
      VALUES (${a.id}, ${directory}, ${CLIENT_ID}, ${encryptField('a-secret', process.env.APP_ENCRYPTION_KEY!)}, 1, ${JSON.stringify(['unclaimed.net'])})`;
    const agent = request.agent(t.app.getHttpServer());
    const start = await agent.get('/api/v1/auth/sso/start').query({ org: a.slug });
    const p = new URL(start.headers.location!).searchParams;
    const code = entra.issueCode({
      claims: { nonce: p.get('nonce'), oid: randomUUID(), email: victim.email, amr: ['mfa'] },
      codeChallenge: p.get('code_challenge')!,
      clientId: p.get('client_id')!,
    });
    const back = await agent
      .get('/api/v1/auth/sso/callback')
      .query({ code, state: p.get('state') });
    expect(back.headers.location).toBe(`${WEB}/login?sso_error=link_not_allowed`);
    const ids = await q`SELECT COUNT(*) as n FROM user_identities WHERE user_id = ${victim.id}`;
    expect(Number(ids[0]!.n)).toBe(0);
    const members = await q`
      SELECT COUNT(*) as n from tenant_members WHERE user_id = ${victim.id} and tenant_id = ${a.id}`;
    expect(Number(members[0]!.n)).toBe(0);
  });

  it('shows the deployment’s settings to the organisation’s admins and refuses to save others', async () => {
    const owner = await createUser(t.owner, org.id, [{ role: 'owner' }], {
      email: `jefa.${Date.now()}@court.gov`,
    });
    const { agent } = await button({ oid: randomUUID(), email: owner.email, amr: ['pwd', 'mfa'] });
    const me = await agent.get('/api/v1/auth/me').expect(200);
    const view = await agent.get('/api/v1/tenant/sso').expect(200);
    expect(view.body).toMatchObject({
      managedByDeployment: true,
      entraTenantId: entraTenantId,
      clientId: CLIENT_ID,
      allowedDomains: ['court.gov'],
    });
    expect(JSON.stringify(view.body)).not.toContain('deploy-secret');
    const put = await agent
      .put('/api/v1/tenant/sso')
      .set('x-csrf-token', me.body.csrfToken as string)
      .send({
        entraTenantId: randomUUID(),
        clientId: CLIENT_ID,
        clientSecret: 'other',
        enabled: false,
        enforceSso: false,
        allowedDomains: ['court.gov'],
      });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe('SSO_MANAGED_BY_DEPLOYMENT');
  });
});

describe.skipIf(!configured).each([false, true])(
  'SQL Server: the deployment’s Microsoft sign-in, with passwords on (ENTRA_ENFORCE=%s)',
  (enforce) => {
    const entra = new MockEntra();
    const slug = `adp-${enforce ? 'e' : 'o'}-${Date.now().toString(36)}`;
    let t: MssqlTestApp;
    let org: { id: string; slug: string };

    beforeAll(async () => {
      await entra.start();
      Object.assign(process.env, {
        ENTRA_AUTHORITY_HOST: entra.host,
        SSO_DEFAULT_ORG: slug,
        ENTRA_TENANT_ID: randomUUID(),
        ENTRA_CLIENT_ID: CLIENT_ID,
        ENTRA_CLIENT_SECRET: 'deploy-secret',
        ENTRA_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
        ENTRA_ALLOWED_DOMAINS: 'court.gov',
        ENTRA_ENFORCE: String(enforce),
      });
      resetConfigCache();
      t = await bootstrap();
      org = await createTenant(t.owner, slug);
    });
    afterAll(async () => {
      await t.close();
      await entra.stop();
      for (const k of [
        'ENTRA_AUTHORITY_HOST',
        'SSO_DEFAULT_ORG',
        'ENTRA_TENANT_ID',
        'ENTRA_CLIENT_ID',
        'ENTRA_CLIENT_SECRET',
        'ENTRA_REDIRECT_URI',
        'ENTRA_ALLOWED_DOMAINS',
        'ENTRA_ENFORCE',
      ])
        delete process.env[k];
      resetConfigCache();
    });

    it(
      enforce
        ? 'requires Microsoft for the default organisation, except for its owners'
        : 'still accepts passwords in the default organisation unless told to require Microsoft',
      async () => {
        const interviewer = await createUser(t.owner, org.id, [{ role: 'interviewer' }]);
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: interviewer.email, password: PASSWORD });
        if (enforce) {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('SSO_REQUIRED');
        } else expect(res.status).toBe(200);
        const owner = await createUser(t.owner, org.id, [{ role: 'owner' }]);
        const s = await login(t, owner);
        const view = await s.agent.get('/api/v1/tenant/sso').expect(200);
        expect(view.body).toMatchObject({ managedByDeployment: true, enforceSso: enforce });
      },
    );
  },
);

describe('configuration of Microsoft-only sign-in', () => {
  const base = () => ({ ...process.env, PASSWORD_LOGIN: 'true' }) as NodeJS.ProcessEnv;
  const deployment = {
    SSO_DEFAULT_ORG: 'pj',
    ENTRA_TENANT_ID: randomUUID(),
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: 'x',
    ENTRA_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
  };

  it('refuses to start without passwords and without the deployment’s directory', () => {
    expect(() => loadConfig({ ...base(), PASSWORD_LOGIN: 'false' })).toThrow(
      /PASSWORD_LOGIN=false/,
    );
    expect(loadConfig({ ...base(), ...deployment, PASSWORD_LOGIN: 'false' }).PASSWORD_LOGIN).toBe(
      false,
    );
  });

  it('refuses Entra ids that are not GUIDs', () => {
    expect(() =>
      loadConfig({ ...base(), ...deployment, ENTRA_TENANT_ID: 'contoso.onmicrosoft.com' }),
    ).toThrow(/ENTRA_TENANT_ID: Directory \(tenant\) ID, a GUID/);
    expect(() => loadConfig({ ...base(), ...deployment, ENTRA_CLIENT_ID: 'my-app' })).toThrow(
      /ENTRA_CLIENT_ID/,
    );
  });

  it('takes empty settings as not set, and the directory whole or not at all', () => {
    const empty = {
      SSO_DEFAULT_ORG: '',
      ENTRA_TENANT_ID: '',
      ENTRA_CLIENT_ID: '',
      ENTRA_CLIENT_SECRET: '',
      ENTRA_REDIRECT_URI: '',
    };
    expect(loadConfig({ ...base(), ...empty }).ENTRA_CLIENT_SECRET).toBeUndefined();
    expect(() => loadConfig({ ...base(), ...deployment, ENTRA_CLIENT_SECRET: '' })).toThrow(
      /ENTRA_CLIENT_SECRET: required with/,
    );
  });

  it('takes the redirect URI with the rest of the directory, https and ending at the callback', () => {
    expect(() => loadConfig({ ...base(), ...deployment, ENTRA_REDIRECT_URI: '' })).toThrow(
      /ENTRA_REDIRECT_URI: required with/,
    );
    for (const bad of [
      'https://app.example.org/auth/callback',
      'http://app.example.org/api/v1/auth/sso/callback',
      'not a url',
    ])
      expect(() => loadConfig({ ...base(), ...deployment, ENTRA_REDIRECT_URI: bad })).toThrow(
        /ENTRA_REDIRECT_URI/,
      );
    const ok = 'https://app.example.org/api/v1/auth/sso/callback';
    expect(
      loadConfig({ ...base(), ...deployment, ENTRA_REDIRECT_URI: ok }).ENTRA_REDIRECT_URI,
    ).toBe(ok);
  });
});
