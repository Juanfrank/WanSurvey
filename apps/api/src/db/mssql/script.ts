import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  APP_USER,
  DEFAULT_SCHEMA,
  loadBaseline,
  migrationFiles,
  readerStatements,
  qualifyTables,
  sqlName,
  tablesOf,
  withNames,
} from './migrate.js';

export interface ScriptOptions {
  /** The schema of the application's tables (default `dbo`). */
  schema?: string;
  /** The read/write user the application connects as (default `wansurvey_app`). */
  appUser?: string;
  /** The read-only user of the analysis model (the `bi_` tables and views); none by default. */
  readonlyUser?: string;
  /**
   * The SQL users are made by the DBA: the script checks that they exist, with the schema as
   * default, instead of making them (and needs no passwords).
   */
  usersByDba?: boolean;
  /** Only the migrations from this one on (an upgrade): `0012` or `0012_name.sql`. No baseline then. */
  from?: string;
  /**
   * `tables`: the schema and the structure (the baseline: plain CREATE statements, no migrations),
   * with no user and no permission (1). `users`: the users (or a check of them) and the permissions
   * of that structure (2), after (1). `migrations`: the migrations the baseline does not cover, with
   * their own permissions, only when there are some (3), after (2). `all` (default): everything, in
   * one file.
   */
  part?: 'all' | 'tables' | 'users' | 'migrations';
  /** A baseline file other than the repository's (tests). */
  baselineFile?: string;
}

/** A batch made only of GRANT, DENY and REVOKE: the permissions, which need the users. */
export function isPermissionBatch(batch: string): boolean {
  const code = batch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
  const statements = code
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  return statements.length > 0 && statements.every((x) => /^(GRANT|DENY|REVOKE)\b/i.test(x));
}

const lit = (v: string) => v.replace(/'/g, "''");

/**
 * What a statement of the baseline is, for the comments that divide the file: its kind (a heading
 * for each kind) and its name (a comment for each object). The statements are already named for the
 * schema chosen, so the names read as they will be in the database.
 */
export function describeStatement(text: string): { group: string; label: string } | null {
  const name = '(?:\\[?\\w+\\]?\\.)?\\[?(\\w+)\\]?';
  const m = (re: string) => new RegExp(`^\\s*${re}`, 'i').exec(text);
  let r: RegExpExecArray | null;
  if ((r = m(`CREATE\\s+TABLE\\s+${name}`))) return { group: 'Tables', label: `Table ${r[1]}` };
  if ((r = m(`ALTER\\s+TABLE\\s+${name}\\s+ADD\\s+CONSTRAINT\\s+\\[?(\\w+)\\]?\\s+FOREIGN`)))
    return { group: 'Foreign keys', label: `${r[1]}: ${r[2]}` };
  if (
    (r = m(
      `CREATE\\s+(?:UNIQUE\\s+)?(?:(?:NON)?CLUSTERED\\s+)?INDEX\\s+\\[?(\\w+)\\]?\\s+ON\\s+${name}`,
    ))
  )
    return { group: 'Indexes', label: `${r[1]} on ${r[2]}` };
  if ((r = m(`CREATE\\s+FUNCTION\\s+${name}`)))
    return { group: 'Functions and views', label: `Function ${r[1]}` };
  if ((r = m(`CREATE\\s+VIEW\\s+${name}`)))
    return { group: 'Functions and views', label: `View ${r[1]}` };
  if ((r = m(`CREATE\\s+PROC(?:EDURE)?\\s+${name}`)))
    return { group: 'Procedures', label: `Procedure ${r[1]}` };
  if ((r = m(`CREATE\\s+TRIGGER\\s+${name}`)))
    return { group: 'Triggers', label: `Trigger ${r[1]}` };
  if ((r = m(`CREATE\\s+SECURITY\\s+POLICY\\s+${name}`)))
    return { group: 'Row-level security', label: `Policy ${r[1]}` };
  if (m('EXEC\\s+(?:\\w+\\.)?bi_refrescar_dimensiones'))
    return { group: 'Initial data', label: 'The dimensions of the analysis model, filled once' };
  if ((r = m(`(?:GRANT|DENY|REVOKE)\\s+[A-Z, ]+\\s+ON\\s+${name}`)))
    return { group: 'Permissions of the application user', label: `On ${r[1]}` };
  return null;
}

/** The migrations that the baseline does not cover (none when there is no baseline, or with `from`). */
export function pendingMigrations(
  options: { from?: string; baselineFile?: string } = {},
): string[] {
  const base = options.from ? null : loadBaseline(options.baselineFile);
  if (!base) return [];
  const covered = new Set(base.covers);
  return migrationFiles()
    .map((f) => f.name)
    .filter((n) => !covered.has(n));
}

/**
 * One T-SQL file, for `sqlcmd`, that does what `runMssqlMigrations` does with the names chosen. A new
 * installation takes the **baseline** (the structure the migrations leave, as plain CREATE statements)
 * and not the history of migrations: (1) the schema and the structure, (2) the users and the
 * permissions, and (3) only if some migration is newer than the baseline, those migrations. Passwords
 * are `sqlcmd` variables (`$(AppPassword)`), never written in it. Each file is one transaction, so a
 * failure leaves nothing half done; (1) and (3) refuse to run twice over what they made, (2) can be
 * run again (to change a password).
 */
export function buildScript(options: ScriptOptions = {}): string {
  const schema = sqlName('The schema', options.schema ?? DEFAULT_SCHEMA);
  const appUser = sqlName('The application user', options.appUser ?? APP_USER);
  const reader = options.readonlyUser ? sqlName('The read-only user', options.readonlyUser) : null;
  if (reader && reader.toLowerCase() === appUser.toLowerCase())
    throw new Error('The read-only user must not be the application user');
  const byDba = !!options.usersByDba;
  const part = options.part ?? 'all';
  const all = migrationFiles();
  const base = options.from ? null : loadBaseline(options.baselineFile);
  let files = all;
  if (options.from) {
    const at = all.findIndex(
      (f) => f.name === options.from || f.name.startsWith(`${options.from}_`),
    );
    if (at < 0) throw new Error(`No migration "${options.from}"`);
    files = all.slice(at);
  }
  if (!files.length) throw new Error('No migrations to write');
  const covers = base?.covers ?? [];
  // Without a baseline (or from a given migration) the migrations are the structure.
  const pendingFiles = base ? files.filter((f) => !covers.includes(f.name)) : [];
  const withStructure = part === 'all' || part === 'tables';
  const withUsers = part === 'all' || part === 'users';
  const withMigrations = part === 'all' || part === 'migrations';
  const passwords = !byDba && withUsers;
  const tables = tablesOf(all);
  const names = { schema, appUser };
  const users = [appUser, ...(reader ? [reader] : [])];
  const migrations = `${schema}.__migrations`;
  const first = (base ? { name: covers[0]! } : files[0]!).name;
  const lastStructure = base ? covers.at(-1)! : files.at(-1)!.name;
  const last = (pendingFiles.at(-1) ?? { name: lastStructure }).name;
  const previous = !base && files !== all ? all[all.indexOf(files[0]!) - 1]! : null;
  const out: string[] = [];
  const batch = (text: string) => out.push(text.trim(), 'GO', '');
  const named = (b: string) => {
    const text = withNames(b, names);
    return schema === DEFAULT_SCHEMA ? text : qualifyTables(text, tables, schema);
  };
  const title = {
    all: 'the schema, structure, security policy and permissions, in one file',
    tables: '(1 of 2, and 3 if migrations are pending) the schema and the structure',
    users: '(2) the SQL users and the permissions, after (1)',
    migrations:
      '(3) the migrations newer than the structure of (1): only if there are any, after (2)',
  }[part];
  const run = `sqlcmd -S <server> -U <owner> -P <password> -d <database> -b -i <this file>${
    passwords ? ` ^\n         -v AppPassword="..."${reader ? ' ReaderPassword="..."' : ''}` : ''
  }`;
  const rule = {
    all: `All of it is one transaction: if a statement fails it stops and nothing is kept. It refuses to
  run again over what it already made (the migrations are recorded in ${migrations}).`,
    tables: `One transaction: if a statement fails it stops and nothing is kept. It refuses to run
  again over what it already made (recorded in ${migrations}). Then run (2).`,
    users: `One transaction. It needs (1) done, and can be run again (to change a password, or after an
  upgrade): it creates what is missing and grants again what is granted.`,
    migrations: `One transaction, with its own permissions. It needs (1) and (2) done and refuses to run twice.
  Only needed when the migrations of this repository are newer than the structure of (1).`,
  }[part];

  out.push(
    `/*
  WanSurvey: ${title}.
  Generated by \`pnpm --filter @wansurvey/api db:script\`${
    base
      ? `; the structure is the baseline of ${covers.length} migrations
  (${first} to ${lastStructure}), written as plain CREATE statements${
    pendingFiles.length
      ? `; ${pendingFiles.length} newer migration${pendingFiles.length === 1 ? '' : 's'} follow (${pendingFiles[0]!.name}${pendingFiles.length > 1 ? ` to ${last}` : ''})`
      : '; no migration is newer'
  }`
      : ` from ${files.length} migrations
  (${files[0]!.name} to ${files.at(-1)!.name})`
  }.
  Do not edit it: generate it again.

  Schema ............ ${schema}
  Read/write user ... ${appUser}${reader ? `\n  Read-only user .... ${reader}` : ''}
  Users ............. ${byDba ? 'made by the DBA before this (checked here)' : 'made here, with the passwords you pass'}

  Run it ONCE as the OWNER of the database (it is \`dbo\` in it), in the database:

  ${run}

  ${rule}
*/
:on error exit
SET NOCOUNT ON;
SET XACT_ABORT ON;
-- The options of an application connection (sqlcmd has some off): indexed views, filtered indexes
-- and computed columns need them, and procedures and views keep the ones they are made with.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
SET QUOTED_IDENTIFIER ON;
GO`,
    '',
  );
  batch(`IF USER_NAME() <> N'dbo' THROW 50001, 'Run it as the owner of the database (dbo).', 1;`);
  if (passwords)
    batch(
      `IF (SELECT containment FROM sys.databases WHERE name = DB_NAME()) = 0
  AND CAST(SERVERPROPERTY('EngineEdition') AS int) <> 5
  THROW 50001, 'The users made here are contained users: the database must be partially contained (01-existing-database.sql).', 1;`,
    );
  batch('BEGIN TRANSACTION;');
  if (withStructure && schema !== DEFAULT_SCHEMA)
    batch(`IF SCHEMA_ID('${schema}') IS NULL EXEC('CREATE SCHEMA [${schema}] AUTHORIZATION dbo');`);
  // What must be there before this file, and what must not be.
  if (part === 'users' || part === 'migrations') {
    const todo = `The structure is not made yet (or not up to ${lastStructure}): run (1) first.`;
    // Two batches: the second names a table that the first has found to exist.
    batch(`IF OBJECT_ID('${migrations}') IS NULL THROW 50002, '${todo}', 1;`);
    batch(
      `IF NOT EXISTS (SELECT 1 FROM ${migrations} WHERE name = N'${lit(lastStructure)}') THROW 50002, '${todo}', 1;`,
    );
  }
  if (withUsers && byDba) {
    for (const u of users)
      batch(
        `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${u}' AND type IN ('S', 'U', 'E', 'X'))
  THROW 50001, 'The SQL user ${u} does not exist: the DBA makes it (infra/sql/03-users.sql).', 1;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${u}' AND default_schema_name = N'${schema}')
  THROW 50001, 'The SQL user ${u} must have the default schema ${schema}: ALTER USER [${u}] WITH DEFAULT_SCHEMA = [${schema}].', 1;`,
      );
  } else if (withUsers) {
    // The schema may be named before it exists (the default schema of a user is only a name).
    const make = (u: string, pw: string) =>
      `IF DATABASE_PRINCIPAL_ID('${u}') IS NULL CREATE USER [${u}] WITH PASSWORD = '$(${pw})', DEFAULT_SCHEMA = [${schema}]; ELSE ALTER USER [${u}] WITH PASSWORD = '$(${pw})', DEFAULT_SCHEMA = [${schema}];`;
    batch(make(appUser, 'AppPassword'));
    if (reader) batch(make(reader, 'ReaderPassword'));
  }
  // A heading when the kind of object changes, and a comment for each object, before its statement.
  const section = (text: string, current: string): string => {
    const d = describeStatement(text);
    if (!d) return current;
    if (d.group !== current)
      out.push(
        `-- ${'═'.repeat(3)} ${d.group} ${'═'.repeat(Math.max(3, 66 - d.group.length))}`,
        '',
      );
    out.push(`-- ─── ${d.label} ${'─'.repeat(Math.max(3, 62 - d.label.length))}`);
    return d.group;
  };
  const recorded = (names: string[]) =>
    `INSERT INTO ${migrations} (name) VALUES ${names.map((n) => `(N'${lit(n)}')`).join(', ')};`;
  if (withStructure) {
    batch(
      `IF OBJECT_ID('${migrations}') IS NULL
  CREATE TABLE ${migrations} (name nvarchar(200) NOT NULL PRIMARY KEY,
    applied_at datetimeoffset(3) NOT NULL DEFAULT SYSDATETIMEOFFSET());`,
    );
  }
  const guard = (wanted: string[], extra = '') => {
    batch(
      `IF EXISTS (SELECT 1 FROM ${migrations} WHERE name IN (${wanted.map((n) => `N'${lit(n)}'`).join(', ')}))
  THROW 50002, 'This part is already applied: this script is for a first run${
    options.from ? ' (generate one with --from for an upgrade)' : ''
  }.', 1;${extra}`,
    );
  };
  if (base) {
    if (withStructure) {
      guard(covers);
      out.push('-- ─── The structure (the baseline) ───', '');
      let group = '';
      for (const b of base.batches) {
        if (isPermissionBatch(b)) continue;
        const text = named(b);
        if (!text) continue;
        group = section(text, group);
        batch(text);
      }
      batch(recorded(covers));
    }
    if (withMigrations && pendingFiles.length) {
      if (part === 'migrations') guard(pendingFiles.map((f) => f.name));
      for (const file of pendingFiles) {
        out.push(`-- ─── ${file.name} ${'─'.repeat(Math.max(3, 70 - file.name.length))}`, '');
        for (const b of file.batches) {
          const text = named(b);
          if (text) batch(text);
        }
        batch(recorded([file.name]));
      }
    } else if (part === 'migrations') {
      out.push(
        '-- No migration is newer than the structure of (1): there is nothing to apply.',
        '',
      );
      batch(`PRINT N'No migrations pending: nothing to do.';`);
    }
    if (withUsers) {
      let group = '';
      for (const b of base.batches)
        if (isPermissionBatch(b)) {
          const text = named(b);
          group = section(text, group);
          batch(text);
        }
    }
  } else {
    if (withStructure) {
      const wanted = files.map((f) => f.name);
      guard(
        wanted,
        previous
          ? `\nIF NOT EXISTS (SELECT 1 FROM ${migrations} WHERE name = N'${lit(previous.name)}')
  THROW 50002, 'The database is not at ${previous.name}: this script continues from there.', 1;`
          : '',
      );
    }
    for (const file of files) {
      const body = file.batches.filter((b) =>
        part === 'all' || part === 'migrations' ? true : isPermissionBatch(b) === !withStructure,
      );
      if (!body.length) continue;
      out.push(`-- ─── ${file.name} ${'─'.repeat(Math.max(3, 70 - file.name.length))}`, '');
      for (const b of body) {
        const text = named(b);
        if (text) batch(text);
      }
      if (withStructure || part === 'migrations') batch(recorded([file.name]));
    }
  }
  if (reader && withUsers) {
    out.push(
      '-- ─── The read-only user: the analysis model (the bi_ objects) and nothing else ───',
      '',
    );
    batch(readerStatements(schema, reader));
  }
  batch('COMMIT TRANSACTION;');
  out.push(
    `PRINT N'Done: ${
      part === 'users'
        ? `users and permissions of schema ${schema}`
        : part === 'migrations'
          ? base && !pendingFiles.length
            ? `no migrations pending in schema ${schema}`
            : `${pendingFiles.length || files.length} migration${(pendingFiles.length || files.length) === 1 ? '' : 's'} applied in schema ${schema}`
          : `the structure of schema ${schema}${base ? ` (${covers.length} migrations in a baseline)` : ` (${files.length} migrations)`}`
    }.';`,
    'GO',
    '',
  );
  return out.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log(`Usage: db:script [--schema survey] [--app-user survey_rw] [--readonly-user survey_ro]
                 [--users-by-dba] [--from 0012] [--part tables|users|migrations] [--out wansurvey.sql]
Names default to DATABASE_SCHEMA, the user of DATABASE_URL and of DATABASE_READONLY_URL.`);
    process.exit(0);
  }
  const userOf = (url: string | undefined) =>
    url ? decodeURIComponent(new URL(url.replace(/^mssql:/, 'http:')).username) : undefined;
  try {
    const text = buildScript({
      schema: arg('schema') ?? process.env.DATABASE_SCHEMA,
      appUser: arg('app-user') ?? userOf(process.env.DATABASE_URL),
      readonlyUser: arg('readonly-user') ?? userOf(process.env.DATABASE_READONLY_URL),
      usersByDba:
        process.argv.includes('--users-by-dba') || process.env.DATABASE_MANAGE_USERS === 'false',
      from: arg('from'),
      ...(arg('part') ? { part: arg('part') as 'all' | 'tables' | 'users' | 'migrations' } : {}),
    });
    const out = arg('out');
    if (out) {
      writeFileSync(out, text);
      console.error(`Written to ${out}`);
    } else process.stdout.write(text);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
