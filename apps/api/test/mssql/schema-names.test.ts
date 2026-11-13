import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/auth.service.js';
import { resetConfigCache } from '../../src/config.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations, sqlName, withNames } from '../../src/db/mssql/migrate.js';
import { MemoryMailer } from '../../src/mail/mailer.js';
import { ADMIN_URL, APP_URL, configured } from './harness.js';

describe('the names of the schema and the users in a migration', () => {
  it('replaces the default schema and application user, and nothing else', () => {
    const batch =
      "CREATE TABLE dbo.users (id int); GRANT SELECT ON dbo.users TO wansurvey_app; -- USER_NAME() = N'dbo'; AUTHORIZATION dbo";
    const out = withNames(batch, { schema: 'survey', appUser: 'svc_survey' });
    expect(out).toBe(
      "CREATE TABLE survey.users (id int); GRANT SELECT ON survey.users TO svc_survey; -- USER_NAME() = N'dbo'; AUTHORIZATION dbo",
    );
    // The defaults leave a migration as it was written.
    expect(withNames(batch, { schema: 'dbo', appUser: 'wansurvey_app' })).toBe(batch);
  });

  it('accepts only names that are safe to put in SQL', () => {
    expect(sqlName('The schema', 'survey_2')).toBe('survey_2');
    for (const bad of ['', '1abc', 'a-b', 'a b', 'x]; DROP', 'a'.repeat(129)])
      expect(() => sqlName('The schema', bad)).toThrow();
  });
});

/** A database of its own, with the schema `survey` and users of other names than the defaults. */
describe.skipIf(!configured)('SQL Server: another schema and other user names', () => {
  const name = `ws_names_${Date.now().toString(36)}`;
  const SCHEMA = 'survey';
  const APP = 'svc_survey_rw';
  const RO = 'svc_survey_ro';
  const APP_PW = 'Rw-Pass-4q9!Lm';
  const RO_PW = 'Ro-Pass-6t2!Xn';
  const PASSWORD = 'correct horse battery';
  const at = (url: string, database: string, user?: string, pw?: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    if (user) {
      u.username = user;
      u.password = pw ?? '';
    }
    return u.toString();
  };
  const master = createMssqlDb<Record<string, never>>(at(ADMIN_URL ?? 'mssql://x@y/z', 'master'), {
    max: 1,
  });
  const adminUrl = ADMIN_URL ? at(ADMIN_URL, name) : '';
  const appUrl = APP_URL ? at(APP_URL, name, APP, APP_PW) : '';
  const roUrl = APP_URL ? at(APP_URL, name, RO, RO_PW) : '';
  let owner: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  const saved: Record<string, string | undefined> = {};
  const ENV = { DATABASE_URL: appUrl, DATABASE_ADMIN_URL: adminUrl, DATABASE_SCHEMA: SCHEMA };
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(owner)) as { rows: Record<string, unknown>[] }).rows;

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE [${name}]`).execute(master);
    await runMssqlMigrations(adminUrl, appUrl, { schema: SCHEMA, readonlyUrl: roUrl });
    owner = createMssqlDb<Record<string, never>>(adminUrl, { max: 2 });
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    resetConfigCache();
    app = await createApp({ mailer: new MemoryMailer() });
    await app.init();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
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

  it('puts the application in the chosen schema, and none of it in dbo', async () => {
    const inSchema = await rows(
      sql`SELECT COUNT(*) AS n FROM sys.tables WHERE SCHEMA_NAME(schema_id) = ${SCHEMA}`,
    );
    expect(Number(inSchema[0]!.n)).toBeGreaterThan(40);
    const inDbo = await rows(
      sql`SELECT COUNT(*) AS n FROM sys.objects WHERE SCHEMA_NAME(schema_id) = 'dbo' AND is_ms_shipped = 0`,
    );
    expect(Number(inDbo[0]!.n)).toBe(0);
    const proc = await rows(
      sql`SELECT COUNT(*) AS n FROM sys.procedures WHERE SCHEMA_NAME(schema_id) = ${SCHEMA} AND name = 'tenant_id_by_slug'`,
    );
    expect(Number(proc[0]!.n)).toBe(1);
    const policy = await rows(sql`SELECT COUNT(*) AS n FROM sys.security_predicates p
      JOIN sys.objects o ON o.object_id = p.target_object_id
      WHERE SCHEMA_NAME(o.schema_id) = ${SCHEMA}`);
    expect(Number(policy[0]!.n)).toBeGreaterThan(40);
  });

  it('gives each user the chosen name and the schema as its default', async () => {
    const users = await rows(sql`SELECT name, default_schema_name FROM sys.database_principals
      WHERE name IN (${APP}, ${RO}) ORDER BY name`);
    expect(users).toEqual([
      { name: RO, default_schema_name: SCHEMA },
      { name: APP, default_schema_name: SCHEMA },
    ]);
    // The default user name of the migrations is not made when another is given.
    const old = await rows(
      sql`SELECT COUNT(*) AS n FROM sys.database_principals WHERE name = 'wansurvey_app'`,
    );
    expect(Number(old[0]!.n)).toBe(0);
  });

  it('runs the application as that user, with no schema named in its queries', async () => {
    const tenant = randomUUID();
    const user = randomUUID();
    const hash = await hashPassword(PASSWORD);
    const q = (t: string) => sql.raw(`${SCHEMA}.${t}`);
    await sql`INSERT INTO ${q('tenants')} (id, name, slug) VALUES (${tenant}, 'T', 'tnames')`.execute(
      owner,
    );
    await sql`INSERT INTO ${q('users')} (id, email, name, status, password_hash)
      VALUES (${user}, 'a@names.test', 'A', 'active', ${hash})`.execute(owner);
    await sql`INSERT INTO ${q('tenant_members')} (id, tenant_id, user_id, status)
      VALUES (${randomUUID()}, ${tenant}, ${user}, 'active')`.execute(owner);
    await sql`INSERT INTO ${q('memberships')} (id, tenant_id, user_id, role)
      VALUES (${randomUUID()}, ${tenant}, ${user}, 'interviewer')`.execute(owner);
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'a@names.test', password: PASSWORD, tenant: 'tnames' });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('a@names.test');
    expect(me.body.memberships).toHaveLength(1);
    expect((await agent.get('/api/v1/projects')).status).toBe(200);
    // The sign-in and the session are rows of the schema, written by the application user.
    const sessions = await rows(sql`SELECT COUNT(*) AS n FROM ${q('sessions')}`);
    expect(Number(sessions[0]!.n)).toBeGreaterThan(0);
  });

  it('keeps the application user under the security policy and unable to alter anything', async () => {
    const as = createMssqlDb<Record<string, never>>(appUrl, { max: 1 });
    const reader = createMssqlDb<Record<string, never>>(roUrl, { max: 1 });
    try {
      const count = async (db: typeof as, t: string) =>
        Number(
          (
            (await sql.raw(`SELECT COUNT(*) AS n FROM ${t}`).execute(db)) as {
              rows: { n: number }[];
            }
          ).rows[0]!.n,
        );
      // No organisation in context: no rows.
      expect(await count(as, 'tenants')).toBe(0);
      await expect(sql.raw('CREATE TABLE x (a int)').execute(as)).rejects.toThrow(/permission/i);
      // The reader sees the analysis model and nothing of the application's tables.
      expect(await count(reader, 'bi.dim_pregunta')).toBe(0);
      await expect(
        sql.raw(`SELECT TOP 1 * FROM ${SCHEMA}.tenants`).execute(reader),
      ).rejects.toThrow(/permission/i);
      await expect(sql.raw('DELETE FROM bi.dim_pregunta').execute(reader)).rejects.toThrow(
        /permission/i,
      );
    } finally {
      await as.destroy();
      await reader.destroy();
    }
  });

  it('applies the migrations again without doing anything, and rejects unsafe names', async () => {
    await runMssqlMigrations(adminUrl, appUrl, { schema: SCHEMA, readonlyUrl: roUrl });
    await expect(runMssqlMigrations(adminUrl, appUrl, { schema: 'bad-name' })).rejects.toThrow(
      /schema/i,
    );
    await expect(
      runMssqlMigrations(adminUrl, appUrl, { schema: SCHEMA, readonlyUrl: appUrl }),
    ).rejects.toThrow(/read-only user must not/i);
  });
});
