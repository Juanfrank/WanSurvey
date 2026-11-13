import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { createMssqlDb, parseMssqlUrl } from './connection.js';
import { byCode } from '../../common/sort.js';

/** The names the migrations were written with: the default of the schema and the application user. */
export const APP_USER = 'wansurvey_app';
export const DEFAULT_SCHEMA = 'dbo';

/** A name that is safe to put in SQL as it is: letters, digits and underscores, not starting with a digit. */
export function sqlName(what: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
    throw new Error(`${what} must be letters, digits and underscores (got "${name}")`);
  return name;
}

/**
 * A migration batch written for schema `dbo` and user `wansurvey_app`, for the schema and user
 * names chosen. The owner stays `dbo` (the database owner): the security policy lets it through
 * and the owner procedures run as it.
 */
export function withNames(batch: string, names: { schema: string; appUser: string }): string {
  let out = batch;
  if (names.schema !== DEFAULT_SCHEMA)
    out = out.replace(/\bdbo\.(?=[A-Za-z_[])/g, `${names.schema}.`);
  if (names.appUser !== APP_USER) out = out.replace(/\bwansurvey_app\b/g, names.appUser);
  return out;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/** The tables the migrations make in the default schema (the ones of the application, not `bi`). */
export function tablesOf(files: { batches: string[] }[]): Set<string> {
  const names = new Set<string>();
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:dbo\\.)?(${IDENT})(?![\\w.])`, 'gi');
  for (const f of files)
    for (const b of f.batches) for (const m of b.matchAll(re)) names.add(m[1]!.toLowerCase());
  return names;
}

/**
 * Names the schema in the places of a migration where a table is expected and none is given (the
 * owner who runs it has `dbo` as its default schema, whatever the application user's is): only
 * for the tables the migrations make, and only after the words that take a table.
 */
export function qualifyTables(batch: string, tables: Set<string>, schema: string): string {
  const name = `(${IDENT})(?![\\w.(])`;
  const after = [
    'CREATE\\s+TABLE',
    'ALTER\\s+TABLE',
    'DROP\\s+TABLE',
    'TRUNCATE\\s+TABLE',
    'INSERT\\s+INTO',
    'DELETE\\s+FROM',
    'DELETE',
    'UPDATE(?:\\s+TOP\\s*\\([^)]*\\))?',
    'FROM',
    'JOIN',
    'REFERENCES',
    'MERGE(?:\\s+INTO)?',
    'USING',
    'CREATE\\s+(?:UNIQUE\\s+)?(?:(?:NON)?CLUSTERED\\s+)?INDEX\\s+\\S+\\s+ON',
    'DROP\\s+INDEX\\s+\\S+\\s+ON',
    'CREATE\\s+TRIGGER\\s+\\S+\\s+ON',
    'GRANT\\s+[A-Z, ]+\\s+ON',
  ];
  const re = new RegExp(`\\b(${after.join('|')})(\\s+)${name}`, 'gi');
  // A trigger is looked up by name in the default schema, which is not the schema of its table.
  const triggers = new RegExp(
    `\\b((?:CREATE|ALTER|DROP)\\s+TRIGGER)(\\s+)(${IDENT})(?![\\w.])`,
    'gi',
  );
  batch = batch.replace(
    triggers,
    (_w, kw: string, space: string, ident: string) => `${kw}${space}${schema}.${ident}`,
  );
  return batch.replace(re, (whole, kw: string, space: string, ident: string) =>
    tables.has(ident.toLowerCase()) ? `${kw}${space}${schema}.${ident}` : whole,
  );
}

export interface MigrationOptions {
  /** The schema the application's tables, procedures and views live in (default `dbo`). */
  schema?: string;
  /** `mssql://…` as the read-only user of the analysis model (schema `bi`); none by default. */
  readonlyUrl?: string;
}

/** The user name and password of an `mssql://` URL. */
function credentialsOf(url: string): { userName: string; password: string } {
  const c = parseMssqlUrl(url);
  const o =
    c.authentication && 'options' in c.authentication
      ? (c.authentication.options as { userName?: string; password?: string })
      : {};
  return { userName: o.userName ?? '', password: o.password ?? '' };
}
const MIGRATIONS = fileURLToPath(new URL('../../../mssql', import.meta.url));

/** The T-SQL files in order, each cut into batches at `--> statement-breakpoint`. */
export function migrationFiles(dir = MIGRATIONS): { name: string; batches: string[] }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort(byCode)
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
export async function runMssqlMigrations(
  adminUrl: string,
  appUrl: string,
  options: MigrationOptions = {},
): Promise<void> {
  const schema = sqlName(
    'The schema',
    options.schema ?? process.env.DATABASE_SCHEMA ?? DEFAULT_SCHEMA,
  );
  const app = credentialsOf(appUrl);
  const appUser = sqlName('The application user', app.userName);
  const password = app.password;
  if (!password) throw new Error('DATABASE_URL needs the application user’s password');
  const readonlyUrl = options.readonlyUrl ?? (process.env.DATABASE_READONLY_URL || undefined);
  const reader = readonlyUrl ? credentialsOf(readonlyUrl) : null;
  if (reader) {
    sqlName('The read-only user', reader.userName);
    if (!reader.password) throw new Error('DATABASE_READONLY_URL needs the user’s password');
    if (reader.userName.toLowerCase() === appUser.toLowerCase())
      throw new Error('The read-only user must not be the application user');
  }
  const names = { schema, appUser };
  const files = migrationFiles();
  const tables = tablesOf(files);

  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    // Contained users need containment on a SQL Server instance (Azure SQL Database has it).
    // These statements cannot run inside a transaction; they change nothing the second time.
    const edition = await sql<{
      e: number;
    }>`SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS e`.execute(db);
    if (edition.rows[0]?.e !== 5) {
      // Only when it is off: an instance whose DBA turned it on needs no server permission here.
      await sql
        .raw(
          `IF (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'contained database authentication') = 0 BEGIN EXEC sp_configure 'contained database authentication', 1; RECONFIGURE; END;`,
        )
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
      const lit = (v: string) => v.replace(/'/g, "''");
      // The schema first (owned by dbo, the database owner), then the users: the application user
      // finds the tables by its default schema, so the application names no schema at all.
      if (schema !== DEFAULT_SCHEMA)
        await sql
          .raw(
            `IF SCHEMA_ID('${schema}') IS NULL EXEC('CREATE SCHEMA [${schema}] AUTHORIZATION dbo');`,
          )
          .execute(tx);
      const user = (name: string, pw: string) =>
        `IF DATABASE_PRINCIPAL_ID('${name}') IS NULL CREATE USER [${name}] WITH PASSWORD = '${lit(pw)}', DEFAULT_SCHEMA = [${schema}]; ELSE ALTER USER [${name}] WITH PASSWORD = '${lit(pw)}', DEFAULT_SCHEMA = [${schema}];`;
      await sql.raw(user(appUser, password)).execute(tx);
      await sql
        .raw(
          `IF OBJECT_ID('${schema}.__migrations') IS NULL
        CREATE TABLE ${schema}.__migrations (name nvarchar(200) NOT NULL PRIMARY KEY,
          applied_at datetimeoffset(3) NOT NULL DEFAULT SYSDATETIMEOFFSET())`,
        )
        .execute(tx);
      const done = await sql<{
        name: string;
      }>`SELECT name FROM ${sql.raw(schema + '.__migrations')}`.execute(tx);
      const applied = new Set(done.rows.map((r) => r.name));
      for (const file of files) {
        if (applied.has(file.name)) continue;
        for (const batch of file.batches) {
          const text = withNames(batch, names);
          const run = schema === DEFAULT_SCHEMA ? text : qualifyTables(text, tables, schema);
          try {
            await sql.raw(run).execute(tx);
          } catch (e) {
            // A failed statement dooms the transaction and its rollback hides the cause: say it here.
            console.error(`Migration ${file.name} failed on: ${run.slice(0, 300)}`);
            throw e;
          }
        }
        await sql`INSERT INTO ${sql.raw(schema + '.__migrations')} (name) VALUES (${file.name})`.execute(
          tx,
        );
      }
      // The read-only user of the analysis model: it reads schema bi and nothing of the
      // application's own tables (explicit refusals, so a broad grant to a role cannot open them).
      if (reader) {
        await sql.raw(user(reader.userName, reader.password)).execute(tx);
        const r = `[${reader.userName}]`;
        await sql
          .raw(
            `GRANT SELECT ON SCHEMA::bi TO ${r};
        DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER ON SCHEMA::bi TO ${r};
        DENY SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[${schema}] TO ${r};`,
          )
          .execute(tx);
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
