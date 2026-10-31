import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createMssqlDb, parseMssqlUrl } from './connection.js';

export const APP_USER = 'wansurvey_app';
const MIGRATIONS = fileURLToPath(new URL('../../../mssql', import.meta.url));

/** The T-SQL files in order, each cut into batches at `--> statement-breakpoint`. */
export function migrationFiles(dir = MIGRATIONS): { name: string; batches: string[] }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({
      name,
      batches: readFileSync(join(dir, name), 'utf8')
        .split('--> statement-breakpoint')
        .map((b) => b.trim())
        .filter(Boolean),
    }));
}

/**
 * Ensures the restricted application user exists (password taken from the app's URL), then
 * applies the T-SQL migrations as the owner. The user is a contained database user, so the same
 * works on Azure SQL Database and on SQL Server; it owns nothing and is always under the
 * security policy.
 */
export async function runMssqlMigrations(adminUrl: string, appUrl: string): Promise<void> {
  const app = parseMssqlUrl(appUrl);
  const user =
    app.authentication && 'options' in app.authentication
      ? (app.authentication.options as { userName?: string; password?: string })
      : {};
  if (user.userName !== APP_USER)
    throw new Error(`DATABASE_URL must connect as ${APP_USER} (got ${user.userName})`);
  const password = user.password ?? '';
  if (!password) throw new Error('DATABASE_URL needs the application user’s password');

  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    // Contained users need containment on a SQL Server instance (Azure SQL Database has it).
    // These statements cannot run inside a transaction; they change nothing the second time.
    const edition = await sql<{
      e: number;
    }>`SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS e`.execute(db);
    if (edition.rows[0]?.e !== 5) {
      await sql
        .raw(`EXEC sp_configure 'contained database authentication', 1; RECONFIGURE;`)
        .execute(db);
      await sql
        .raw(
          `DECLARE @d sysname = DB_NAME(); DECLARE @s nvarchar(400) = N'ALTER DATABASE ' + QUOTENAME(@d) + N' SET CONTAINMENT = PARTIAL'; IF (SELECT containment FROM sys.databases WHERE name = @d) = 0 EXEC (@s);`,
        )
        .execute(db);
    }
    // One at a time: a second process starting together waits, and finds nothing left to do.
    // The lock belongs to this transaction.
    await db.transaction().execute(async (tx) => {
      await sql`DECLARE @r int;
        EXEC @r = sp_getapplock @Resource = N'wansurvey.migrations', @LockMode = N'Exclusive',
          @LockOwner = N'Transaction', @LockTimeout = 600000;
        IF @r < 0 THROW 50002, 'Could not take the migrations lock', 1;`.execute(tx);
      const pw = password.replace(/'/g, "''");
      await sql
        .raw(
          `IF DATABASE_PRINCIPAL_ID('${APP_USER}') IS NULL CREATE USER ${APP_USER} WITH PASSWORD = '${pw}'; ELSE ALTER USER ${APP_USER} WITH PASSWORD = '${pw}';`,
        )
        .execute(tx);
      await sql`IF OBJECT_ID('dbo.__migrations') IS NULL
        CREATE TABLE dbo.__migrations (name nvarchar(200) NOT NULL PRIMARY KEY,
          applied_at datetimeoffset(3) NOT NULL DEFAULT SYSDATETIMEOFFSET())`.execute(tx);
      const done = await sql<{ name: string }>`SELECT name FROM dbo.__migrations`.execute(tx);
      const applied = new Set(done.rows.map((r) => r.name));
      for (const file of migrationFiles()) {
        if (applied.has(file.name)) continue;
        for (const batch of file.batches) await sql.raw(batch).execute(tx);
        await sql`INSERT INTO dbo.__migrations (name) VALUES (${file.name})`.execute(tx);
      }
    });
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const admin = process.env.DATABASE_ADMIN_URL;
  const app = process.env.DATABASE_URL;
  if (!admin || !app) {
    console.error('DATABASE_ADMIN_URL and DATABASE_URL are required');
    process.exit(1);
  }
  runMssqlMigrations(admin, app)
    .then(() => console.log('SQL Server migrations applied'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
