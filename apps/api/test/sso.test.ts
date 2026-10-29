import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { encryptField } from '../src/common/crypto.js';
import { resetConfigCache } from '../src/config.js';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  PASSWORD,
  type TestApp,
} from './harness.js';
import { MockEntra, type IssuedCode } from './mock-entra.js';

const WEB = 'http://localhost:5173';
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

describe('Microsoft Entra ID sign-in', () => {
  const entra = new MockEntra();
  let t: TestApp;

  beforeAll(async () => {
    await entra.start();
    process.env.ENTRA_AUTHORITY_HOST = entra.host;
    process.env.PUBLIC_WEB_URL = WEB;
    resetConfigCache();
    t = await bootstrap();
  });
  afterAll(async () => {
    await t.close();
    await entra.stop();
    delete process.env.ENTRA_AUTHORITY_HOST;
    delete process.env.PUBLIC_WEB_URL;
    resetConfigCache();
  });

  /** An organisation linked to its own Entra tenant. */
  async function ssoTenant(
    opts: { enforce?: boolean; domains?: string[]; entraTenantId?: string } = {},
  ) {
    const tenant = await createTenant(t.admin);
    const entraTenantId = opts.entraTenantId ?? randomUUID();
    await t.admin`
      insert into tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, enforce_sso, allowed_domains)
      values (${tenant.id}, ${entraTenantId}, ${CLIENT_ID}, ${encryptField('s3cret', process.env.APP_ENCRYPTION_KEY!)},
              true, ${opts.enforce ?? false}, ${opts.domains ?? ['agency.org']})`;
    return { ...tenant, entraTenantId };
  }

  /**
   * Drives the browser round trip: start → (Microsoft) → callback. `claims` are what Microsoft
   * puts in the ID token; `tamper` adjusts the code for negative tests.
   */
  async function signIn(
    org: string,
    claims: Record<string, unknown>,
    tamper: Partial<IssuedCode> & { state?: string; returnTo?: string; dropNonce?: boolean } = {},
    agent = request.agent(t.app.getHttpServer()),
  ) {
    const start = await agent
      .get('/api/v1/auth/sso/start')
      .query({ org, ...(tamper.returnTo ? { returnTo: tamper.returnTo } : {}) });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location!);
    const p = authorize.searchParams;
    const code = entra.issueCode({
      claims: { ...(tamper.dropNonce ? {} : { nonce: p.get('nonce') }), ...claims },
      codeChallenge: p.get('code_challenge')!,
      clientId: p.get('client_id')!,
      ...tamper,
    });
    const callback = await agent
      .get('/api/v1/auth/sso/callback')
      .query({ code, state: tamper.state ?? p.get('state') });
    return { agent, start, authorize, callback };
  }

  const person = (email: string, extra: Record<string, unknown> = {}) => ({
    oid: randomUUID(),
    email,
    name: 'Ana Pérez',
    given_name: 'Ana',
    amr: ['pwd'],
    ...extra,
  });

  it('starts the authorization code flow with PKCE against the organisation’s Entra tenant', async () => {
    const org = await ssoTenant();
    const { authorize, start } = await signIn(org.slug, person(`a@agency.org`));
    expect(authorize.origin + authorize.pathname).toBe(
      `${entra.host}/${org.entraTenantId}/oauth2/v2.0/authorize`,
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: 'code',
      code_challenge_method: 'S256',
      redirect_uri: `${WEB}/api/v1/auth/sso/callback`,
      scope: 'openid profile email',
    });
    const cookie = (start.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('ws_sso='),
    )!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).not.toContain(authorize.searchParams.get('nonce')!); // encrypted, not readable
    const sent = entra.tokenRequests.at(-1)!;
    expect(sent.get('client_secret')).toBe('s3cret');
    expect(sent.get('code_verifier')).toBeTruthy();
  });

  it('first sign-in creates an account with no role and a waiting-for-access state', async () => {
    const org = await ssoTenant();
    const owner = await createUser(t.admin, org.id, [{ role: 'owner' }]);
    await createProject(t.admin, org.id);
    const email = `new-${uuidv7()}@agency.org`;
    const { agent, callback } = await signIn(org.slug, person(email), { returnTo: '/home' });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`${WEB}/home`);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([]);
    expect(me.body.access.state).toBe('no_role');
    expect(me.body.access.message).toMatch(/no role has been assigned/);
    expect((await agent.get('/api/v1/projects')).status).toBe(403);

    expect(t.mailer.last(owner.email)!.subject).toMatch(/waiting for access/);
    const [row] =
      await t.admin`select status, password_hash from users where lower(email) = ${email}`;
    expect(row).toMatchObject({ status: 'active', password_hash: null });
    const audit =
      await t.admin`select action from audit_log where tenant_id = ${org.id} and action = 'user.provisioned_sso'`;
    expect(audit).toHaveLength(1);

    // The admin sees them as waiting for a role, assigns one, and access works.
    const a = await login(t.app, owner, org.slug);
    const listed = (await a.agent.get('/api/v1/users')).body.find(
      (u: { email: string }) => u.email === email,
    );
    expect(listed.awaitingRole).toBe(true);
    await a.agent
      .put(`/api/v1/users/${listed.id}/memberships`)
      .set('x-csrf-token', a.csrf)
      .send({ memberships: [{ role: 'interviewer' }] });
    const me2 = await agent.get('/api/v1/auth/me');
    expect(me2.body.access.state).toBe('ok');
    expect((await agent.get('/api/v1/projects')).status).toBe(200);
  });

  it('later sign-ins reuse the linked identity, even after the e-mail changes', async () => {
    const org = await ssoTenant();
    const claims = person(`same-${uuidv7()}@agency.org`);
    await signIn(org.slug, claims);
    const again = await signIn(org.slug, { ...claims, email: `renamed-${uuidv7()}@elsewhere.com` });
    expect(again.callback.headers.location).toBe(`${WEB}/`);
    const links = await t.admin`select user_id from user_identities where subject = ${claims.oid}`;
    expect(links).toHaveLength(1);
  });

  it('links an existing account and activates an invitation', async () => {
    const org = await ssoTenant();
    const user = await createUser(t.admin, org.id, [{ role: 'supervisor' }], {
      email: `invited-${uuidv7()}@agency.org`,
      memberStatus: 'invited',
    });
    const { agent, callback } = await signIn(org.slug, person(user.email.toUpperCase()));
    expect(callback.status).toBe(302);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.user.id).toBe(user.id);
    expect(me.body.memberships).toMatchObject([{ role: 'supervisor', projectId: null }]);
    const [m] =
      await t.admin`select status from tenant_members where user_id = ${user.id} and tenant_id = ${org.id}`;
    expect(m!.status).toBe('active');
  });

  it('never takes over an account of another organisation by its e-mail alone', async () => {
    // The victim works in another organisation; the attacker runs an organisation whose
    // directory can put any address in a token.
    const victimOrg = await createTenant(t.admin);
    const victim = await createUser(t.admin, victimOrg.id, [{ role: 'admin' }], {
      email: `boss-${uuidv7()}@agency.org`,
    });
    const attacker = await ssoTenant();
    const { agent, callback } = await signIn(
      attacker.slug,
      person(victim.email, { amr: ['pwd', 'mfa'] }),
    );
    expect(callback.headers.location).toBe(`${WEB}/login?sso_error=link_required`);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect(await t.admin`select 1 from user_identities where user_id = ${victim.id}`).toHaveLength(
      0,
    );
    expect(
      await t.admin`select 1 from tenant_members where user_id = ${victim.id} and tenant_id = ${attacker.id}`,
    ).toHaveLength(0);
  });

  it('links an account of several organisations when its owner is signed in with it', async () => {
    const home = await createTenant(t.admin);
    const org = await ssoTenant();
    const user = await createUser(t.admin, home.id, [{ role: 'supervisor' }], {
      email: `two-${uuidv7()}@agency.org`,
    });
    await t.admin`insert into tenant_members (id, tenant_id, user_id, status) values (${uuidv7()}, ${org.id}, ${user.id}, 'invited')`;
    const signedIn = await login(t.app, user, home.slug);
    const { agent, callback } = await signIn(org.slug, person(user.email), {}, signedIn.agent);
    expect(callback.headers.location).not.toContain('sso_error');
    expect((await agent.get('/api/v1/auth/me')).body.user.id).toBe(user.id);
    expect(await t.admin`select 1 from user_identities where user_id = ${user.id}`).toHaveLength(1);
  });

  it('an identity linked in another organisation on the same directory needs an allowed domain here', async () => {
    const a = await ssoTenant();
    const b = await ssoTenant({
      entraTenantId: a.entraTenantId,
      domains: [`b${uuidv7().slice(-8)}.org`],
    });
    const claims = person(`shared-${uuidv7()}@agency.org`);
    expect((await signIn(a.slug, claims)).callback.headers.location).toBe(`${WEB}/`);
    const other = await signIn(b.slug, claims);
    expect(other.callback.headers.location).toBe(`${WEB}/login?sso_error=domain_not_allowed`);
    const [u] = await t.admin`select user_id from user_identities where subject = ${claims.oid}`;
    expect(
      await t.admin`select 1 from tenant_members where user_id = ${u!.user_id} and tenant_id = ${b.id}`,
    ).toHaveLength(0);
  });

  it('a mail server that fails does not fail the first sign-in', async () => {
    const org = await ssoTenant();
    await createUser(t.admin, org.id, [{ role: 'owner' }]);
    const send = t.mailer.send;
    t.mailer.send = () => Promise.reject(new Error('SMTP down'));
    try {
      const { agent, callback } = await signIn(org.slug, person(`m-${uuidv7()}@agency.org`));
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(`${WEB}/`);
      expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    } finally {
      t.mailer.send = send;
    }
  });

  it('two first sign-ins of one person at once both succeed, with one account', async () => {
    const org = await ssoTenant();
    const claims = person(`twice-${uuidv7()}@agency.org`);
    const http = t.app.getHttpServer();
    // Both browsers are at Microsoft before either comes back.
    const legs = await Promise.all(
      [0, 1].map(async () => {
        const agent = request.agent(http);
        const start = await agent.get('/api/v1/auth/sso/start').query({ org: org.slug });
        const p = new URL(start.headers.location!).searchParams;
        const code = entra.issueCode({
          claims: { nonce: p.get('nonce'), ...claims },
          codeChallenge: p.get('code_challenge')!,
          clientId: p.get('client_id')!,
        });
        return { agent, code, state: p.get('state') };
      }),
    );
    const backs = await Promise.all(
      legs.map((l) =>
        l.agent.get('/api/v1/auth/sso/callback').query({ code: l.code, state: l.state }),
      ),
    );
    for (const b of backs) expect(b.headers.location, b.text).toBe(`${WEB}/`);
    expect(await t.admin`select 1 from users where lower(email) = ${claims.email}`).toHaveLength(1);
  });

  it('refuses deactivated members, foreign domains and unknown organisations', async () => {
    const org = await ssoTenant();
    const gone = await createUser(t.admin, org.id, [{ role: 'interviewer' }], {
      email: `gone-${uuidv7()}@agency.org`,
      memberStatus: 'deactivated',
    });
    expect((await signIn(org.slug, person(gone.email))).callback.headers.location).toBe(
      `${WEB}/login?sso_error=membership_deactivated`,
    );
    expect(
      (await signIn(org.slug, person(`x-${uuidv7()}@gmail.com`))).callback.headers.location,
    ).toBe(`${WEB}/login?sso_error=domain_not_allowed`);
    const res = await request(t.app.getHttpServer())
      .get('/api/v1/auth/sso/start')
      .query({ org: 'no-such-org' });
    expect(res.headers.location).toBe(`${WEB}/login?sso_error=sso_not_configured`);
    const audit =
      await t.admin`select details from audit_log where tenant_id = ${org.id} and action = 'auth.sso_failed'`;
    expect(audit.map((a) => a.details.code).sort()).toEqual([
      'domain_not_allowed',
      'membership_deactivated',
    ]);
  });

  it.each([
    ['tampered state', { state: 'not-the-state' }, 'invalid_state'],
    ['missing nonce', { dropNonce: true }, 'invalid_token'],
    ['wrong audience', { audience: '99999999-9999-9999-9999-999999999999' }, 'invalid_token'],
    ['wrong issuer', { issuer: 'https://evil.example/v2.0' }, 'invalid_token'],
    ['expired token', { expiresInSeconds: -3600 }, 'invalid_token'],
    ['bad signature', { signWithOtherKey: true }, 'invalid_token'],
  ] as const)('rejects a %s', async (_label, tamper, code) => {
    const org = await ssoTenant();
    const { callback, agent } = await signIn(org.slug, person(`t-${uuidv7()}@agency.org`), tamper);
    expect(callback.headers.location).toBe(`${WEB}/login?sso_error=${code}`);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a token issued for a different Entra tenant', async () => {
    const org = await ssoTenant();
    const { callback } = await signIn(
      org.slug,
      person(`tid-${uuidv7()}@agency.org`, { tid: randomUUID() }),
    );
    expect(callback.headers.location).toBe(`${WEB}/login?sso_error=invalid_token`);
  });

  it('never redirects off-site after sign-in', async () => {
    const org = await ssoTenant();
    for (const returnTo of ['//evil.example/x', 'https://evil.example', '/\\evil.example']) {
      const { callback } = await signIn(org.slug, person(`r-${uuidv7()}@agency.org`), { returnTo });
      expect(callback.headers.location).toBe(`${WEB}/`);
    }
  });

  it('trusts Microsoft MFA instead of asking for the WanSurvey code', async () => {
    const org = await ssoTenant();
    const owner = await createUser(t.admin, org.id, [{ role: 'owner' }], {
      email: `own-${uuidv7()}@agency.org`,
    });
    const claims = person(owner.email, { amr: ['pwd', 'mfa'] });
    const withMfa = await signIn(org.slug, claims);
    expect((await withMfa.agent.get('/api/v1/tenant')).status).toBe(200);
    // Same person, Microsoft did not perform MFA this time: WanSurvey's own code is required.
    const withoutMfa = await signIn(org.slug, { ...claims, amr: ['pwd'] });
    const blocked = await withoutMfa.agent.get('/api/v1/tenant');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_REQUIRED');
  });

  it('finds the organisation from the e-mail domain', async () => {
    const domain = `d${uuidv7().slice(-8)}.org`;
    const org = await ssoTenant({ domains: [domain] });
    const res = await request(t.app.getHttpServer())
      .get('/api/v1/auth/sso/start')
      .query({ email: `x@${domain}` });
    expect(res.headers.location).toContain(`/${org.entraTenantId}/oauth2/v2.0/authorize`);
  });

  describe('enforcement', () => {
    it('blocks password sign-in except for owners, and accepts Microsoft sign-in', async () => {
      const org = await ssoTenant({ enforce: true });
      const interviewer = await createUser(t.admin, org.id, [{ role: 'interviewer' }], {
        email: `i-${uuidv7()}@agency.org`,
      });
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: interviewer.email, password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SSO_REQUIRED');
      expect(res.body.ssoStartUrl).toContain(`/api/v1/auth/sso/start?org=${org.slug}`);

      const owner = await createUser(t.admin, org.id, [{ role: 'owner' }]);
      expect((await login(t.app, owner, org.slug)).tenantId).toBe(org.id); // break-glass

      const { agent } = await signIn(org.slug, person(interviewer.email));
      expect((await agent.get('/api/v1/auth/me')).body.user.id).toBe(interviewer.id);
    });

    it('password sign-in falls back to an organisation that allows it', async () => {
      const strict = await ssoTenant({ enforce: true });
      const open = await createTenant(t.admin);
      const user = await createUser(t.admin, strict.id, [{ role: 'interviewer' }]);
      await createUser(t.admin, open.id, [{ role: 'interviewer' }], { existing: user });
      const s = await login(t.app, user);
      expect(s.tenantId).toBe(open.id);
      const sw = await s.agent
        .post('/api/v1/auth/switch-tenant')
        .set('x-csrf-token', s.csrf)
        .send({ tenantId: strict.id });
      expect(sw.status).toBe(403);
      expect(sw.body.code).toBe('SSO_REQUIRED');
    });
  });

  describe('settings', () => {
    it('admins save settings; the secret is encrypted and never returned', async () => {
      const org = await createTenant(t.admin);
      const admin = await createUser(t.admin, org.id, [{ role: 'admin' }]);
      const a = await login(t.app, admin, org.slug);
      const empty = await a.agent.get('/api/v1/tenant/sso');
      expect(empty.body).toMatchObject({
        configured: false,
        redirectUri: `${WEB}/api/v1/auth/sso/callback`,
      });

      const put = (body: object) =>
        a.agent.put('/api/v1/tenant/sso').set('x-csrf-token', a.csrf).send(body);
      const base = {
        entraTenantId: randomUUID(),
        clientId: CLIENT_ID,
        enabled: true,
        allowedDomains: [`Settings-${org.slug}.org`],
      };
      expect((await put(base)).status).toBe(400); // no secret yet
      expect((await put({ ...base, clientSecret: 'x', allowedDomains: [] })).status).toBe(400);
      expect(
        (await put({ ...base, clientSecret: 'x', enabled: false, enforceSso: true })).status,
      ).toBe(400);
      const saved = await put({ ...base, clientSecret: 'super-secret-value' });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        configured: true,
        hasClientSecret: true,
        allowedDomains: [`settings-${org.slug}.org`],
      });
      expect(JSON.stringify(saved.body)).not.toContain('super-secret-value');
      // A domain another organisation uses is refused.
      const taken = await put({ ...base, allowedDomains: ['agency.org'] });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('DOMAIN_TAKEN');
      const [row] =
        await t.admin`select client_secret_enc from tenant_sso where tenant_id = ${org.id}`;
      expect(row!.client_secret_enc).toMatch(/^v1\./);
      // Updating without a secret keeps the stored one.
      expect((await put({ ...base, enforceSso: true })).body).toMatchObject({
        enforceSso: true,
        hasClientSecret: true,
      });
      const [log] =
        await t.admin`select details from audit_log where tenant_id = ${org.id} and action = 'tenant.sso_updated' order by at limit 1`;
      expect(JSON.stringify(log!.details)).not.toContain('super-secret-value');
    });

    it('two organisations saving the same domain at once cannot both get it', async () => {
      const domain = `race-${uuidv7().slice(-8)}.org`;
      const admins = await Promise.all(
        [0, 1].map(async () => {
          const org = await createTenant(t.admin);
          return login(t.app, await createUser(t.admin, org.id, [{ role: 'admin' }]), org.slug);
        }),
      );
      const results = await Promise.all(
        admins.map((a) =>
          a.agent
            .put('/api/v1/tenant/sso')
            .set('x-csrf-token', a.csrf)
            .send({
              entraTenantId: randomUUID(),
              clientId: CLIENT_ID,
              clientSecret: 'x',
              enabled: true,
              allowedDomains: [domain],
            }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const owners =
        await t.admin`select tenant_id from tenant_sso where ${domain} = any (allowed_domains)`;
      expect(owners).toHaveLength(1);
    });
  });
});
