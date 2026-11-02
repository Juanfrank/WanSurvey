import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetConfigCache } from '../../src/config.js';
import { ensureInitialAdmin, organisationFor } from '../../src/db/initial-admin.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { MemoryMailer } from '../../src/mail/mailer.js';
import { MockEntra } from '../mock-entra.js';
import { ADMIN_URL, APP_URL, configured } from './harness.js';

const WEB = 'http://localhost:5173';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UPN = 'Ana.Admin@Agency.GOV';

describe('the organisation of the initial administrator', () => {
  it('is named after the domain of the UPN', () => {
    expect(organisationFor('ana@poderjudicial.gob.do')).toEqual({
      name: 'poderjudicial.gob.do',
      slug: 'poderjudicial-gob-do',
    });
  });
});

/** A database of its own: the initial administrator is for an installation with no organisation. */
describe.skipIf(!configured)('SQL Server: INITIAL_ADMIN_USER', () => {
  const entra = new MockEntra();
  const entraTenantId = randomUUID();
  const name = `ws_init_${Date.now().toString(36)}`;
  const at = (url: string, database: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const master = createMssqlDb<Record<string, never>>(at(ADMIN_URL ?? 'mssql://x@y/z', 'master'), {
    max: 1,
  });
  const adminUrl = ADMIN_URL ? at(ADMIN_URL, name) : '';
  const appUrl = APP_URL ? at(APP_URL, name) : '';
  const directory = { entraTenantId, clientId: CLIENT_ID };
  let owner: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    DATABASE_URL: appUrl,
    DATABASE_ADMIN_URL: adminUrl,
    ENTRA_AUTHORITY_HOST: '',
    PUBLIC_URL: WEB,
    PASSWORD_LOGIN: 'false',
    ENTRA_TENANT_ID: entraTenantId,
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: 'deploy-secret',
    ENTRA_REDIRECT_URI: 'http://localhost:5173/api/auth/entra/callback',
  };

  beforeAll(async () => {
    await entra.start();
    ENV.ENTRA_AUTHORITY_HOST = entra.host;
    await sql.raw(`CREATE DATABASE [${name}]`).execute(master);
    await runMssqlMigrations(adminUrl, appUrl);
    owner = createMssqlDb<Record<string, never>>(adminUrl, { max: 2 });
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    resetConfigCache();
  });
  afterAll(async () => {
    await owner.destroy();
    await entra.stop();
    await sql
      .raw(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
      .execute(master);
    await sql.raw(`DROP DATABASE [${name}]`).execute(master);
    await master.destroy();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    resetConfigCache();
  });

  it('creates the organisation and its owner, once', async () => {
    expect(await ensureInitialAdmin(adminUrl, UPN, directory)).toBe('created');
    const [org] = await sql<{
      slug: string;
      name: string;
      enabled: boolean;
      allowed_domains: string;
      entra_tenant_id: string;
    }>`SELECT t.slug, t.name, s.enabled, s.allowed_domains, s.entra_tenant_id
       FROM tenants t JOIN tenant_sso s ON s.tenant_id = t.id`
      .execute(owner)
      .then((r) => r.rows);
    expect(org).toMatchObject({ slug: 'agency-gov', name: 'agency.gov' });
    expect(Boolean(org!.enabled)).toBe(true);
    expect(JSON.parse(org!.allowed_domains)).toEqual(['agency.gov']);
    expect(org!.entra_tenant_id.toLowerCase()).toBe(entraTenantId.toLowerCase());
    const members = await sql<{
      email: string;
      role: string;
      status: string;
      password_hash: string | null;
    }>`
      SELECT u.email, m.role, u.status, u.password_hash FROM users u JOIN memberships m ON m.user_id = u.id`.execute(
      owner,
    );
    expect(members.rows).toEqual([
      { email: 'ana.admin@agency.gov', role: 'owner', status: 'pending', password_hash: null },
    ]);
    // Again (a restart, a second instance): nothing more.
    expect(await ensureInitialAdmin(adminUrl, UPN, directory)).toBe('present');
    const n = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM tenants`.execute(owner);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('does not make a way in on an installation that already has organisations', async () => {
    expect(await ensureInitialAdmin(adminUrl, 'other@elsewhere.org', directory)).toBe('ignored');
    const users = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`.execute(owner);
    expect(Number(users.rows[0]!.n)).toBe(1);
  });

  it('lets the administrator in with Microsoft as the owner, with no password', async () => {
    const mailer = new MemoryMailer();
    const app = await createApp({ mailer });
    await app.init();
    try {
      const agent = request.agent(app.getHttpServer());
      const start = await agent.get('/api/v1/auth/sso/start').query({ email: UPN.toLowerCase() });
      expect(start.status).toBe(302);
      const p = new URL(start.headers.location!).searchParams;
      const code = entra.issueCode({
        claims: {
          nonce: p.get('nonce'),
          oid: randomUUID(),
          email: UPN.toLowerCase(),
          name: 'Ana Admin',
          amr: ['pwd', 'mfa'],
        },
        codeChallenge: p.get('code_challenge')!,
        clientId: p.get('client_id')!,
      });
      const back = await agent
        .get('/api/auth/entra/callback')
        .query({ code, state: p.get('state') });
      expect(back.headers.location).toBe(`${WEB}/`);
      const me = await agent.get('/api/v1/auth/me').expect(200);
      expect(me.body.memberships).toMatchObject([{ role: 'owner' }]);
      const [row] = await sql<{ status: string }>`
        SELECT u.status FROM users u WHERE u.email = 'ana.admin@agency.gov'`
        .execute(owner)
        .then((r) => r.rows);
      expect(row!.status).toBe('active');
      // The login of a person who is not the administrator and is not invited: nothing given away.
      const stranger = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: UPN, password: 'anything-long-enough' });
      expect(stranger.status).toBe(403);
    } finally {
      await app.close();
    }
  }, 60_000);
});
