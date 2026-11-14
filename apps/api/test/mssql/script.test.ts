import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection, Request } from 'tedious';
import { createMssqlDb, parseMssqlUrl } from '../../src/db/mssql/connection.js';
import { migrationFiles } from '../../src/db/mssql/migrate.js';
import { buildScript } from '../../src/db/mssql/script.js';
import { ADMIN_URL, configured } from './harness.js';

describe('the one-file SQL script', () => {
  it('names the schema and the users, writes no password, and leaves nothing in dbo', () => {
    const text = buildScript({ schema: 'survey', appUser: 'survey_rw', readonlyUser: 'survey_ro' });
    expect(text).toContain('CREATE SCHEMA [survey]');
    expect(text).toContain("PASSWORD = '$(AppPassword)'");
    expect(text).toContain("PASSWORD = '$(ReaderPassword)'");
    expect(text).not.toMatch(/\bdbo\.(?=[A-Za-z_[])/);
    expect(text).not.toContain('wansurvey_app');
    expect(text).toContain('GRANT SELECT ON SCHEMA::bi TO [survey_ro]');
    expect(text.match(/INSERT INTO survey\.__migrations/g)).toHaveLength(migrationFiles().length);
    expect(text.indexOf('BEGIN TRANSACTION')).toBeLessThan(text.indexOf('COMMIT TRANSACTION'));
  });

  it('checks the users instead of making them when the DBA makes them', () => {
    const text = buildScript({ schema: 'survey', appUser: 'survey_rw', usersByDba: true });
    expect(text).not.toContain('CREATE USER');
    expect(text).not.toContain('$(AppPassword)');
    expect(text).toContain('must have the default schema survey');
  });

  it('writes only the later migrations for an upgrade, and says where it continues from', () => {
    const all = migrationFiles();
    const last = all.at(-1)!.name;
    const text = buildScript({ from: last.slice(0, 4) });
    expect(text.match(/INSERT INTO dbo\.__migrations/g)).toHaveLength(1);
    expect(text).toContain(`The database is not at ${all.at(-2)!.name}`);
    expect(() => buildScript({ from: '9999' })).toThrow(/No migration/);
  });

  it('splits into (1) the tables and (2) the users and every permission', () => {
    const opts = { schema: 'survey', appUser: 'survey_rw', readonlyUser: 'survey_ro' };
    const tables = buildScript({ ...opts, part: 'tables' });
    const users = buildScript({ ...opts, part: 'users' });
    expect(tables).toContain('CREATE TABLE survey.tenants');
    expect(tables).not.toContain('CREATE USER');
    expect(tables).not.toMatch(/^GRANT [A-Z, ]+ ON survey\.\w+ TO survey_rw/m);
    expect(users).not.toContain('CREATE TABLE survey.tenants');
    expect(users).toMatch(/^GRANT [A-Z, ]+ ON survey\.\w+ TO survey_rw/m);
    expect(users).toContain('run (1) first');
    expect(users).not.toContain('INSERT INTO survey.__migrations');
  });

  it('refuses unsafe names and a reader that is the application user', () => {
    expect(() => buildScript({ schema: 'a]; DROP' })).toThrow();
    expect(() => buildScript({ appUser: 'x', readonlyUser: 'X' })).toThrow();
  });
});

/** Runs the file as sqlcmd would: batches split at GO, variables replaced, one connection. */
describe.skipIf(!configured)('SQL Server: running the generated file', () => {
  const name = `ws_script_${Date.now().toString(36)}`;
  const at = (database: string) => {
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const master = createMssqlDb<Record<string, never>>(at('master'), { max: 1 });
  let db: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  const batches = (text: string) =>
    text
      .replace(/\$\(AppPassword\)/g, 'Rw-Pass-4q9!Lm')
      .replace(/\$\(ReaderPassword\)/g, 'Ro-Pass-6t2!Xn')
      .split(/^GO\s*$/m)
      .map((b) =>
        b
          .split('\n')
          .filter((l) => !l.startsWith(':on error'))
          .join('\n')
          .trim(),
      )
      .filter(Boolean);
  const run = async (text: string) => {
    // One connection and plain batches, as sqlcmd does: the transaction spans the batches (Kysely
    // wraps each statement in a procedure call, where it could not).
    const conn = new Connection(parseMssqlUrl(at(name)));
    await new Promise<void>((ok, fail) => conn.connect((e) => (e ? fail(e) : ok())));
    try {
      for (const b of batches(text))
        await new Promise<void>((ok, fail) =>
          conn.execSqlBatch(new Request(b, (e) => (e ? fail(e) : ok()))),
        );
    } finally {
      conn.close();
    }
  };
  const script = buildScript({ schema: 'survey', appUser: 'svs_rw', readonlyUser: 'svs_ro' });

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE [${name}] CONTAINMENT = PARTIAL`).execute(master);
    db = createMssqlDb<Record<string, never>>(at(name), { max: 1 });
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
    await sql
      .raw(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
      .execute(master);
    await sql.raw(`DROP DATABASE [${name}]`).execute(master);
    await master.destroy();
  });

  it('makes the tables, the users and the record, and refuses a second run', async () => {
    await run(script);
    const n = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM sys.tables
      WHERE SCHEMA_NAME(schema_id) = 'survey'`.execute(db);
    expect(Number(n.rows[0]!.n)).toBeGreaterThan(40);
    const u = await sql<{ name: string; s: string }>`SELECT name, default_schema_name AS s
      FROM sys.database_principals WHERE name IN ('svs_rw', 'svs_ro') ORDER BY name`.execute(db);
    expect(u.rows).toEqual([
      { name: 'svs_ro', s: 'survey' },
      { name: 'svs_rw', s: 'survey' },
    ]);
    const m = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM survey.__migrations`.execute(db);
    expect(Number(m.rows[0]!.n)).toBe(migrationFiles().length);
    await expect(run(script)).rejects.toThrow(/already applied/);
  }, 180_000);

  it('runs in two parts: the tables first, then the users and permissions, which can repeat', async () => {
    const two = `${name}_b`;
    await sql.raw(`CREATE DATABASE [${two}] CONTAINMENT = PARTIAL`).execute(master);
    const opts = { schema: 'survey', appUser: 'svs_rw', readonlyUser: 'svs_ro' } as const;
    const put = async (text: string) => {
      const conn = new Connection(parseMssqlUrl(at(two)));
      await new Promise<void>((ok, fail) => conn.connect((e) => (e ? fail(e) : ok())));
      try {
        for (const b of batches(text))
          await new Promise<void>((ok, fail) =>
            conn.execSqlBatch(new Request(b, (e) => (e ? fail(e) : ok()))),
          );
      } finally {
        conn.close();
      }
    };
    try {
      await expect(put(buildScript({ ...opts, part: 'users' }))).rejects.toThrow();
      await put(buildScript({ ...opts, part: 'tables' }));
      const other = createMssqlDb<Record<string, never>>(at(two), { max: 1 });
      try {
        const count = async () =>
          Number(
            (
              await sql<{
                n: number;
              }>`SELECT COUNT(*) AS n FROM sys.database_principals WHERE name IN ('svs_rw', 'svs_ro')`.execute(
                other,
              )
            ).rows[0]!.n,
          );
        expect(await count()).toBe(0);
        await put(buildScript({ ...opts, part: 'users' }));
        await put(buildScript({ ...opts, part: 'users' }));
        expect(await count()).toBe(2);
        const grants = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM sys.database_permissions
          WHERE USER_NAME(grantee_principal_id) = 'svs_rw' AND class = 1`.execute(other);
        expect(Number(grants.rows[0]!.n)).toBeGreaterThan(100);
      } finally {
        await other.destroy();
      }
    } finally {
      await sql
        .raw(`ALTER DATABASE [${two}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
        .execute(master);
      await sql.raw(`DROP DATABASE [${two}]`).execute(master);
    }
  }, 240_000);
});
