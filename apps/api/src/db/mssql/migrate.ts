import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql, type Kysely } from 'kysely';
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
 *
 * Everything lives in the one schema chosen: what the migrations name `bi.x` (the analysis model)
 * and `rls.x` (the row-level security) is `<schema>.bi_x` and `<schema>.rls_x`, and the two extra
 * schemas are not made (an empty string: nothing to run).
 */
export function withNames(batch: string, names: { schema: string; appUser: string }): string {
  let out = batch;
  const code = out
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .trim();
  if (/^CREATE\s+SCHEMA\s+(bi|rls)(\s+AUTHORIZATION\s+dbo)?\s*;?$/i.test(code)) return '';
  // A renamed object of the model keeps the prefix: sp_rename N'bi.a', N'b' makes bi_b.
  out = out.replace(/(sp_rename\s+N')bi\.(\w+)(',\s*N')(\w+)(')/gi, '$1dbo.bi_$2$3bi_$4$5');
  out = out
    .replace(/\bbi\.(?=[A-Za-z_[])/g, 'dbo.bi_')
    .replace(/\brls\.(?=[A-Za-z_[])/g, 'dbo.rls_');
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
  // The model's tables (`CREATE TABLE bi.x`) are `bi_x` in the one schema.
  const model = new RegExp(`CREATE\\s+TABLE\\s+bi\\.(${IDENT})(?![\\w.])`, 'gi');
  for (const f of files)
    for (const b of f.batches) {
      for (const m of b.matchAll(re)) names.add(m[1]!.toLowerCase());
      for (const m of b.matchAll(model)) names.add(`bi_${m[1]!.toLowerCase()}`);
    }
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

/**
 * What the read-only user may do, all in the one schema: SELECT on the tables and views of the
 * analysis model (`bi_*`), an explicit refusal of SELECT on every other table and view (so a later
 * broad grant to a role cannot open them), and no INSERT, UPDATE, DELETE, EXECUTE or ALTER on the
 * schema. Repeatable; run again after a migration adds tables or views.
 */
export function readerStatements(schema: string, reader: string): string {
  const s = schema.replace(/'/g, "''");
  const r = reader.replace(/]/g, ']]');
  return `DECLARE @grants nvarchar(max) = N'';
SELECT @grants += CASE WHEN o.name LIKE N'bi[_]%' THEN N'GRANT' ELSE N'DENY' END
    + N' SELECT ON ' + QUOTENAME(SCHEMA_NAME(o.schema_id)) + N'.' + QUOTENAME(o.name) + N' TO [${r}];' + NCHAR(10)
  FROM sys.objects o WHERE o.schema_id = SCHEMA_ID(N'${s}') AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0;
SET @grants += N'DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER ON SCHEMA::' + QUOTENAME(N'${s}') + N' TO [${r}];';
EXEC (@grants);`;
}

export interface MigrationOptions {
  /** The schema the application's tables, procedures and views live in (default `dbo`). */
  schema?: string;
  /** `mssql://…` as the read-only user of the analysis model (schema `bi`); none by default. */
  readonlyUrl?: string;
  /**
   * false: the users already exist, made by the DBA; only the schema, the tables and the grants are
   * made (default: the `DATABASE_MANAGE_USERS` setting, else true).
   */
  manageUsers?: boolean;
  /** false: apply every migration, even on a new database (how the baseline is made). Default true. */
  baseline?: boolean;
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
export const BASELINE_FILE = join(MIGRATIONS, 'baseline.sql');

/**
 * The baseline (see `baseline.ts`): the structure the migrations up to `covers` leave, as plain
 * statements, or null when there is none. A new database takes it instead of those migrations.
 */
export function loadBaseline(file = BASELINE_FILE): { covers: string[]; batches: string[] } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const covers = /^-- covers: (.+)$/m.exec(text)?.[1]?.split(', ') ?? [];
  const batches = text
    .split('--> statement-breakpoint')
    .map((b) => b.replace(/^(--[^\n]*\n)+/, '').trim())
    .filter(Boolean);
  return covers.length ? { covers, batches } : null;
}

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

/** With the users made by the DBA: they must be there, with the schema as default, before granting. */
async function requireUsers(
  tx: Kysely<Record<string, never>>,
  schema: string,
  names: string[],
): Promise<void> {
  for (const n of names) {
    const r = await sql<{ s: string | null }>`SELECT default_schema_name AS s
      FROM sys.database_principals WHERE name = ${n} AND type IN ('S', 'U', 'E', 'X')`.execute(tx);
    if (!r.rows.length)
      throw new Error(
        `The SQL user ${n} does not exist in the database: DATABASE_MANAGE_USERS is false, so the DBA makes it (infra/sql/03-users.sql)`,
      );
    // The application writes no schema in its queries: its user finds the tables by its default
    // schema, which the DBA sets when making it.
    if (r.rows[0]?.s?.toLowerCase() !== schema.toLowerCase())
      throw new Error(
        `The SQL user ${n} has the default schema ${r.rows[0]?.s ?? '(none)'}, not ${schema}: ALTER USER [${n}] WITH DEFAULT_SCHEMA = [${schema}]`,
      );
  }
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
  const manageUsers = options.manageUsers ?? process.env.DATABASE_MANAGE_USERS !== 'false';
  const password = app.password;
  if (manageUsers && !password)
    throw new Error('DATABASE_URL needs the application user’s password');
  const readonlyUrl = options.readonlyUrl ?? (process.env.DATABASE_READONLY_URL || undefined);
  const reader = readonlyUrl ? credentialsOf(readonlyUrl) : null;
  if (reader) {
    sqlName('The read-only user', reader.userName);
    if (manageUsers && !reader.password)
      throw new Error('DATABASE_READONLY_URL needs the user’s password');
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
    if (manageUsers && edition.rows[0]?.e !== 5) {
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
      if (manageUsers) await sql.raw(user(appUser, password)).execute(tx);
      else await requireUsers(tx, schema, [appUser, ...(reader ? [reader.userName] : [])]);
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
      // A new database takes the baseline instead of replaying the migrations it covers.
      const base = applied.size === 0 && options.baseline !== false ? loadBaseline() : null;
      if (base) {
        for (const batch of base.batches) {
          const text = withNames(batch, names);
          const run = schema === DEFAULT_SCHEMA ? text : qualifyTables(text, tables, schema);
          try {
            await sql.raw(run).execute(tx);
          } catch (e) {
            console.error(`The baseline failed on: ${run.slice(0, 300)}`);
            throw e;
          }
        }
        for (const name of base.covers) {
          await sql`INSERT INTO ${sql.raw(schema + '.__migrations')} (name) VALUES (${name})`.execute(
            tx,
          );
          applied.add(name);
        }
      }
      for (const file of files) {
        if (applied.has(file.name)) continue;
        for (const batch of file.batches) {
          const text = withNames(batch, names);
          if (!text) continue;
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
      // The read-only user of the analysis model (the `bi_` tables and views of the schema): it reads
      // those and nothing of the application's own tables.
      if (reader) {
        if (manageUsers) await sql.raw(user(reader.userName, reader.password)).execute(tx);
        await sql.raw(readerStatements(schema, reader.userName)).execute(tx);
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
