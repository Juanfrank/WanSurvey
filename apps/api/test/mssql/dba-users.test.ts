import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { ADMIN_URL, APP_URL, configured } from './harness.js';

/**
 * The DBA makes the users (here mapped from server logins, in a database that is not contained)
 * and the migrations only make the schema and the tables and grant the permissions.
 */
describe.skipIf(!configured)('SQL Server: users made by the DBA', () => {
  const stamp = Date.now().toString(36);
  const name = `ws_dba_${stamp}`;
  const SCHEMA = 'survey';
  const RW = `dba_rw_${stamp}`;
  const RO = `dba_ro_${stamp}`;
  const PW = 'Dba-Pass-7k2!Qz';
  const at = (url: string, database: string, user?: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    if (user) {
      u.username = user;
      u.password = PW;
    }
    return u.toString();
  };
  const master = createMssqlDb<Record<string, never>>(at(ADMIN_URL ?? 'mssql://x@y/z', 'master'), {
    max: 1,
  });
  const adminUrl = ADMIN_URL ? at(ADMIN_URL, name) : '';
  const appUrl = APP_URL ? at(APP_URL, name, RW) : '';
  const roUrl = APP_URL ? at(APP_URL, name, RO) : '';
  const run = (text: string) => sql.raw(text).execute(owner);
  let owner: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  const migrate = () =>
    runMssqlMigrations(adminUrl, appUrl, {
      schema: SCHEMA,
      readonlyUrl: roUrl,
      manageUsers: false,
    });

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE [${name}]`).execute(master);
    for (const u of [RW, RO])
      await sql
        .raw(`CREATE LOGIN [${u}] WITH PASSWORD = '${PW}', CHECK_POLICY = OFF`)
        .execute(master);
    owner = createMssqlDb<Record<string, never>>(adminUrl, { max: 1 });
    await run(`CREATE TABLE dbo.other_app (id int)`);
  }, 60_000);
  afterAll(async () => {
    await owner.destroy();
    await sql
      .raw(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
      .execute(master);
    await sql.raw(`DROP DATABASE [${name}]`).execute(master);
    for (const u of [RW, RO]) await sql.raw(`DROP LOGIN [${u}]`).execute(master);
    await master.destroy();
  });

  it('asks for the users to exist, with the schema as their default', async () => {
    await expect(migrate()).rejects.toThrow(/does not exist in the database/);
    await run(`CREATE USER [${RW}] FOR LOGIN [${RW}]`);
    await run(`CREATE USER [${RO}] FOR LOGIN [${RO}]`);
    await expect(migrate()).rejects.toThrow(/default schema dbo, not survey/);
    // Nothing was made by the failed runs.
    const t = await run(`SELECT 1 AS x FROM sys.schemas WHERE name = '${SCHEMA}'`);
    expect(t.rows).toHaveLength(0);
  });

  it('makes the tables and the grants, and touches neither the users nor the database', async () => {
    await run(`ALTER USER [${RW}] WITH DEFAULT_SCHEMA = [${SCHEMA}]`);
    await run(`ALTER USER [${RO}] WITH DEFAULT_SCHEMA = [${SCHEMA}]`);
    await migrate();
    await migrate(); // again: nothing left to do
    const q = async (text: string) =>
      ((await run(text)) as { rows: Record<string, unknown>[] }).rows;
    expect(
      Number(
        (
          await q(`SELECT COUNT(*) AS n FROM sys.tables WHERE SCHEMA_NAME(schema_id) = '${SCHEMA}'`)
        )[0]!.n,
      ),
    ).toBeGreaterThan(40);
    expect(Number((await q(`SELECT COUNT(*) AS n FROM dbo.other_app`))[0]!.n)).toBe(0);
    // Still not contained, and no user made by the migrations.
    expect((await q(`SELECT containment FROM sys.databases WHERE name = '${name}'`))[0]).toEqual({
      containment: 0,
    });
    const users = await q(
      `SELECT name FROM sys.database_principals WHERE type = 'S' AND name NOT IN ('dbo','guest','INFORMATION_SCHEMA','sys') ORDER BY name`,
    );
    expect(users.map((u) => u.name).sort()).toEqual([RO, RW].sort());
  });

  it('lets the application user work under row-level security, and the reader read bi only', async () => {
    const app = createMssqlDb<Record<string, never>>(appUrl, { max: 1 });
    const ro = createMssqlDb<Record<string, never>>(roUrl, { max: 1 });
    try {
      const rows = await sql`SELECT COUNT(*) AS n FROM tenants`.execute(app);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(0);
      await expect(sql`DROP TABLE tenants`.execute(app)).rejects.toThrow();
      await expect(sql`SELECT COUNT(*) AS n FROM tenants`.execute(ro)).rejects.toThrow();
      await sql`SELECT TOP 1 * FROM bi.dim_proyecto`.execute(ro);
    } finally {
      await app.destroy();
      await ro.destroy();
    }
  });
});
