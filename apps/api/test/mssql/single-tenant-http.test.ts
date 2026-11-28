import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/auth.service.js';
import { resetConfigCache } from '../../src/config.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { MemoryMailer } from '../../src/mail/mailer.js';
import { ADMIN_URL, APP_URL, configured, PASSWORD } from './harness.js';

const ENTRA_TENANT = randomUUID();
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * SINGLE_TENANT=true, on a database of its own (the number of organisations matters): the routes
 * that exist only with several organisations answer 404, sign-in and the Microsoft start always
 * open the one, a new installation serves its first organisation once it appears, and a database
 * with several stops the start. Without the setting nothing changes.
 */
describe.skipIf(!configured)('SQL Server: single-tenant mode', () => {
  const name = `ws_single_${Date.now().toString(36)}`;
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
  let owner: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SINGLE_TENANT'];
  const apps: INestApplication[] = [];

  /** Starts the application on the test database, in single-tenant mode or not. */
  async function start(single: boolean) {
    if (single) process.env.SINGLE_TENANT = 'true';
    else delete process.env.SINGLE_TENANT;
    resetConfigCache();
    const made = await createApp({ mailer: new MemoryMailer() });
    try {
      await made.init();
    } catch (e) {
      await made.close().catch(() => undefined);
      throw e;
    }
    apps.push(made);
    return made;
  }

  async function org(slug: string) {
    const id = randomUUID();
    await sql`INSERT INTO tenants (id, name, slug) VALUES (${id}, ${slug}, ${slug})`.execute(owner);
    return { id: id.toLowerCase(), slug };
  }

  /** An interviewer (no second factor) in each of these organisations. */
  async function person(email: string, tenantIds: string[]) {
    const id = randomUUID();
    await sql`INSERT INTO users (id, email, name, status, password_hash)
              VALUES (${id}, ${email}, ${email}, 'active', ${await hashPassword(PASSWORD)})`.execute(
      owner,
    );
    for (const t of tenantIds) {
      await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status)
                VALUES (${randomUUID()}, ${t}, ${id}, 'active')`.execute(owner);
      await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
                VALUES (${randomUUID()}, ${t}, ${id}, 'interviewer')`.execute(owner);
    }
    return { id, email };
  }

  const login = (a: INestApplication, email: string, tenant?: string) => {
    const agent = request.agent(a.getHttpServer());
    return agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD, ...(tenant ? { tenant } : {}) })
      .then((res) => ({ agent, res, csrf: res.body.csrfToken as string }));
  };

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE [${name}]`).execute(master);
    await runMssqlMigrations(adminUrl, appUrl);
    owner = createMssqlDb<Record<string, never>>(adminUrl, { max: 2 });
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { DATABASE_URL: appUrl, DATABASE_ADMIN_URL: adminUrl });
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });
  afterAll(async () => {
    await owner.destroy();
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

  let first: { id: string; slug: string };
  const ana = 'ana@single.test';
  const both = 'both@single.test';
  const ids = (list: { id: string }[]) => list.map((t) => t.id);

  it('a new installation starts with no organisation and serves the first once it exists', async () => {
    const a = await start(true);
    const methods = await request(a.getHttpServer()).get('/api/v1/auth/methods');
    expect(methods.body).toEqual({
      password: true,
      microsoftNeedsEmail: false,
      singleTenant: true,
    });
    // Nobody to sign in yet; then the first organisation is made (as INITIAL_ADMIN_USER does).
    expect((await login(a, ana)).res.status).toBe(401);
    first = await org('first');
    await person(ana, [first.id]);
    // There is no organisation to choose: whatever is asked for, the one opens.
    const { agent, res, csrf } = await login(a, ana, 'elsewhere');
    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe(first.id);
    expect(ids(res.body.tenants)).toEqual([first.id]);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.singleTenant).toBe(true);
    expect(ids(me.body.tenants)).toEqual([first.id]);
    // The routes about several organisations do not exist here.
    const list = await agent.get('/api/v1/auth/tenants');
    expect(list.status).toBe(404);
    expect(list.body.code).toBe('SINGLE_TENANT');
    const sw = await agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', csrf)
      .send({ tenantId: first.id });
    expect(sw.status).toBe(404);
    expect(sw.body.code).toBe('SINGLE_TENANT');
  });

  it('Microsoft sign-in starts in the one organisation, with no e-mail or organisation given', async () => {
    await sql`
      INSERT INTO tenant_sso (tenant_id, entra_tenant_id, client_id, client_secret_enc, enabled, allowed_domains)
      VALUES (${first.id}, ${ENTRA_TENANT}, ${CLIENT_ID}, NULL, 1, ${JSON.stringify(['single.test'])})`.execute(
      owner,
    );
    const a = await start(true);
    for (const query of [{}, { org: 'other' }, { email: 'x@elsewhere.org' }]) {
      const res = await request(a.getHttpServer()).get('/api/v1/auth/sso/start').query(query);
      expect(res.status).toBe(302);
      const to = new URL(res.headers.location!);
      expect(to.pathname).toBe(`/${ENTRA_TENANT}/oauth2/v2.0/authorize`);
      expect(to.searchParams.get('client_id')).toBe(CLIENT_ID);
    }
  });

  it('an organisation made after the start is never served; the default mode lists and switches', async () => {
    const single = await start(true);
    const second = await org('second');
    await person(both, [first.id, second.id]);
    // Without the setting: both organisations, the choice at sign-in and the switch.
    const multi = await start(false);
    const methods = await request(multi.getHttpServer()).get('/api/v1/auth/methods');
    expect(methods.body).toEqual({
      password: true,
      microsoftNeedsEmail: true,
      singleTenant: false,
    });
    const m = await login(multi, both, 'second');
    expect(m.res.body.tenant.id).toBe(second.id);
    expect(m.res.body.tenants).toHaveLength(2);
    expect((await m.agent.get('/api/v1/auth/me')).body.singleTenant).toBe(false);
    expect((await m.agent.get('/api/v1/auth/tenants')).body).toHaveLength(2);
    const cookies = m.res.headers['set-cookie'] as unknown as string[];
    // The single-tenant instance keeps serving the first: the second's session has ended there,
    // and signing in to the second opens the first.
    const stale = await request(single.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookies);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_EXPIRED');
    const s = await login(single, both, 'second');
    expect(s.res.body.tenant.id).toBe(first.id);
    expect(ids(s.res.body.tenants)).toEqual([first.id]);
    // Back in the default mode the switch works.
    const sw = await m.agent
      .post('/api/v1/auth/switch-tenant')
      .set('x-csrf-token', m.csrf)
      .send({ tenantId: first.id });
    expect(sw.status).toBe(200);
    expect(sw.body.tenant.id).toBe(first.id);
  });

  it('a database with several organisations stops the start, saying why', async () => {
    await expect(start(true)).rejects.toThrow(
      'SINGLE_TENANT=true, but the database has 2 organisations: the mode serves one; turn it off (SINGLE_TENANT=false) or keep a single organisation in the database',
    );
  });
});
