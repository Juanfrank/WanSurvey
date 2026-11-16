import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { createMssqlDb } from './connection.js';
import { APP_USER, BASELINE_FILE, migrationFiles, runMssqlMigrations } from './migrate.js';

/**
 * The baseline: the structure the migrations leave, written as plain `CREATE` statements (no history
 * of `ALTER`s, renames or backfills), generated from the catalog of a database that the migrations
 * made. A new installation runs it instead of the migrations (`covers` names the ones it replaces),
 * and only a database made before it needs the migrations after it. Regenerate it with
 * `pnpm --filter @wansurvey/api db:baseline`; a test compares a database made from it with one made
 * by the migrations.
 */

type Db = Kysely<Record<string, never>>;
const rows = async <T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> =>
  ((await q.execute(db)) as { rows: T[] }).rows;
/** `[dbo].[x]` as `dbo.x`, the way the migrations are written (the names are rewritten for the schema chosen). */
const plain = (t: string) => t.replace(/\[dbo\]\.\[?([A-Za-z_][A-Za-z0-9_]*)\]?/g, 'dbo.$1');
/**
 * A constraint SQL Server named by itself (`PK__users__3213E83F…`, a random suffix) gets a name
 * that says what it is, the same in every database made from the baseline.
 */
const tidy = (name: string, wanted: string) => (/^(PK|UQ|DF|CK|FK)__/.test(name) ? wanted : name);
/** The index options that are not the default (SQL Server's `WITH (...)`). */
const withOptions = (o: {
  ignore_dup_key: boolean;
  fill_factor: number;
  is_padded: boolean;
  allow_row_locks: boolean;
  allow_page_locks: boolean;
}) => {
  const list = [
    ...(o.ignore_dup_key ? ['IGNORE_DUP_KEY = ON'] : []),
    ...(o.fill_factor > 0 ? [`FILLFACTOR = ${o.fill_factor}`] : []),
    ...(o.is_padded ? ['PAD_INDEX = ON'] : []),
    ...(o.allow_row_locks ? [] : ['ALLOW_ROW_LOCKS = OFF']),
    ...(o.allow_page_locks ? [] : ['ALLOW_PAGE_LOCKS = OFF']),
  ];
  return list.length ? ` WITH (${list.join(', ')})` : '';
};
const q = (n: string) => `[${n.replace(/]/g, ']]')}]`;

interface Col {
  table: string;
  name: string;
  type: string;
  max_length: number;
  precision: number;
  scale: number;
  is_nullable: boolean;
  is_identity: boolean;
  seed: number | null;
  inc: number | null;
  computed: string | null;
  persisted: boolean | null;
  collation: string | null;
  df_name: string | null;
  df_def: string | null;
}

function typeOf(c: Col): string {
  const t = c.type;
  const len =
    c.max_length === -1 ? 'max' : String(t.startsWith('n') ? c.max_length / 2 : c.max_length);
  if (['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(t))
    return `${t}(${len})`;
  if (t === 'decimal' || t === 'numeric') return `${t}(${c.precision},${c.scale})`;
  if (['datetime2', 'datetimeoffset', 'time'].includes(t)) return `${t}(${c.scale})`;
  if (t === 'float') return c.precision === 53 ? 'float' : `float(${c.precision})`;
  if (t === 'timestamp') return 'rowversion';
  return t;
}

/** Tables with their columns, defaults, keys and checks (foreign keys and indexes follow). */
async function tables(db: Db, dbCollation: string): Promise<string[]> {
  const tabs = await rows<{ id: number; name: string }>(
    db,
    sql`SELECT object_id AS id, name FROM sys.tables WHERE is_ms_shipped = 0 AND name <> '__migrations' ORDER BY name`,
  );
  const out: string[] = [];
  for (const t of tabs) {
    const cols = await rows<Col>(
      db,
      sql`SELECT c.name, ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
            CAST(ic.seed_value AS bigint) AS seed, CAST(ic.increment_value AS bigint) AS inc,
            cc.definition AS computed, cc.is_persisted AS persisted,
            c.collation_name AS collation, d.name AS df_name, d.definition AS df_def
          FROM sys.columns c
          JOIN sys.types ty ON ty.user_type_id = c.user_type_id
          LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
          LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
          LEFT JOIN sys.default_constraints d ON d.parent_object_id = c.object_id AND d.parent_column_id = c.column_id
          WHERE c.object_id = ${t.id} ORDER BY c.column_id`,
    );
    const lines = cols.map((c) => {
      if (c.computed) return `  ${q(c.name)} AS ${c.computed}${c.persisted ? ' PERSISTED' : ''}`;
      const collate = c.collation && c.collation !== dbCollation ? ` COLLATE ${c.collation}` : '';
      const identity = c.is_identity ? ` IDENTITY(${c.seed},${c.inc})` : '';
      const df = c.df_name
        ? ` CONSTRAINT ${q(tidy(c.df_name, `df_${t.name}_${c.name}`))} DEFAULT ${c.df_def}`
        : '';
      return `  ${q(c.name)} ${typeOf(c)}${collate}${identity} ${c.is_nullable ? 'NULL' : 'NOT NULL'}${df}`;
    });
    // Primary key and unique constraints, as the index that backs them.
    const keys = await rows<{
      name: string;
      kind: string;
      is_clustered: boolean;
      cols: string;
      ignore_dup_key: boolean;
      fill_factor: number;
      is_padded: boolean;
      allow_row_locks: boolean;
      allow_page_locks: boolean;
    }>(
      db,
      sql`SELECT i.name, CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS kind,
            i.ignore_dup_key, i.fill_factor, i.is_padded, i.allow_row_locks, i.allow_page_locks,
            CASE WHEN i.type = 1 THEN 1 ELSE 0 END AS is_clustered,
            (SELECT STRING_AGG(CAST(QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END AS nvarchar(max)), ', ')
               WITHIN GROUP (ORDER BY ic.key_ordinal)
             FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0) AS cols
          FROM sys.indexes i WHERE i.object_id = ${t.id} AND (i.is_primary_key = 1 OR i.is_unique_constraint = 1)
          ORDER BY i.is_primary_key DESC, i.name`,
    );
    for (const k of keys)
      lines.push(
        `  CONSTRAINT ${q(tidy(k.name, `${k.kind === 'PRIMARY KEY' ? 'pk' : 'uq'}_${t.name}${k.kind === 'PRIMARY KEY' ? '' : `_${k.cols.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`}`))} ${k.kind} ${k.is_clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${k.cols})${withOptions(k)}`,
      );
    const checks = await rows<{ name: string; def: string }>(
      db,
      sql`SELECT name, definition AS def FROM sys.check_constraints WHERE parent_object_id = ${t.id} ORDER BY name`,
    );
    checks.forEach((c, i) =>
      lines.push(`  CONSTRAINT ${q(tidy(c.name, `ck_${t.name}_${i + 1}`))} CHECK ${c.def}`),
    );
    out.push(`CREATE TABLE dbo.${t.name} (\n${lines.join(',\n')}\n);`);
  }
  return out;
}

async function foreignKeys(db: Db): Promise<string[]> {
  const fks = await rows<{
    name: string;
    child: string;
    parent: string;
    cols: string;
    refs: string;
    del: string;
    upd: string;
  }>(
    db,
    sql`SELECT fk.name, OBJECT_NAME(fk.parent_object_id) AS child, OBJECT_NAME(fk.referenced_object_id) AS parent,
          (SELECT STRING_AGG(CAST(QUOTENAME(pc.name) AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id)
             FROM sys.foreign_key_columns fkc JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
             WHERE fkc.constraint_object_id = fk.object_id) AS cols,
          (SELECT STRING_AGG(CAST(QUOTENAME(rc.name) AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id)
             FROM sys.foreign_key_columns fkc JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
             WHERE fkc.constraint_object_id = fk.object_id) AS refs,
          fk.delete_referential_action_desc AS del, fk.update_referential_action_desc AS upd
        FROM sys.foreign_keys fk WHERE fk.is_ms_shipped = 0 AND OBJECT_NAME(fk.parent_object_id) <> '__migrations'
        ORDER BY OBJECT_NAME(fk.parent_object_id), fk.name`,
  );
  const action = (a: string) => (a === 'NO_ACTION' ? '' : ` ${a.replace('_', ' ')}`);
  return fks.map(
    (f) =>
      `ALTER TABLE dbo.${f.child} ADD CONSTRAINT ${q(tidy(f.name, `fk_${f.child}_${f.cols.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`))} FOREIGN KEY (${f.cols}) REFERENCES dbo.${f.parent} (${f.refs})${
        f.del === 'NO_ACTION' ? '' : ` ON DELETE${action(f.del)}`
      }${f.upd === 'NO_ACTION' ? '' : ` ON UPDATE${action(f.upd)}`};`,
  );
}

async function indexes(db: Db): Promise<string[]> {
  const ix = await rows<{
    name: string;
    table: string;
    unique: boolean;
    is_clustered: boolean;
    cols: string;
    incl: string | null;
    filter: string | null;
    ignore_dup_key: boolean;
    fill_factor: number;
    is_padded: boolean;
    allow_row_locks: boolean;
    allow_page_locks: boolean;
  }>(
    db,
    sql`SELECT i.name, OBJECT_NAME(i.object_id) AS [table], i.is_unique AS [unique], CASE WHEN i.type = 1 THEN 1 ELSE 0 END AS is_clustered,
          (SELECT STRING_AGG(CAST(QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)
             FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0) AS cols,
          (SELECT STRING_AGG(CAST(QUOTENAME(c.name) AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY ic.index_column_id)
             FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1) AS incl,
          i.filter_definition AS [filter], i.ignore_dup_key, i.fill_factor, i.is_padded, i.allow_row_locks, i.allow_page_locks
        FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
        WHERE t.is_ms_shipped = 0 AND t.name <> '__migrations' AND i.type IN (1, 2)
          AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
        ORDER BY OBJECT_NAME(i.object_id), i.name`,
  );
  return ix.map(
    (i) =>
      `CREATE ${i.unique ? 'UNIQUE ' : ''}${i.is_clustered ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${q(i.name)} ON dbo.${i.table} (${i.cols})${
        i.incl ? ` INCLUDE (${i.incl})` : ''
      }${i.filter ? ` WHERE ${i.filter}` : ''}${withOptions(i)};`,
  );
}

/** Functions, views, procedures and triggers, as the catalog holds them; those that others need first. */
async function modules(db: Db): Promise<string[]> {
  const mods = await rows<{ id: number; name: string; type: string; def: string }>(
    db,
    sql`SELECT o.object_id AS id, o.name, RTRIM(o.type) AS type, m.definition AS def
        FROM sys.objects o JOIN sys.sql_modules m ON m.object_id = o.object_id
        WHERE o.is_ms_shipped = 0 AND o.type IN ('FN', 'IF', 'TF', 'V', 'P', 'TR') ORDER BY o.name`,
  );
  const deps = await rows<{ from: number; to: number }>(
    db,
    sql`SELECT d.referencing_id AS [from], d.referenced_id AS [to] FROM sys.sql_expression_dependencies d
        WHERE d.referenced_id IS NOT NULL AND d.referencing_id <> d.referenced_id`,
  );
  const byId = new Map(mods.map((m) => [m.id, m]));
  const early = (m: { type: string }) => ['FN', 'IF', 'TF', 'V'].includes(m.type);
  // Functions and views in dependency order (a view may read a function and another view), then the rest.
  const first = mods.filter(early);
  const need = new Map(first.map((m) => [m.id, new Set<number>()]));
  for (const d of deps) if (need.has(d.from) && need.has(d.to)) need.get(d.from)!.add(d.to);
  const ordered: typeof mods = [];
  const done = new Set<number>();
  while (ordered.length < first.length) {
    const next = first.filter(
      (m) => !done.has(m.id) && [...need.get(m.id)!].every((x) => done.has(x)),
    );
    if (!next.length) throw new Error('A cycle among the functions and views');
    for (const m of next) {
      ordered.push(m);
      done.add(m.id);
    }
  }
  const rest = mods.filter((m) => !early(m) && byId.has(m.id));
  const triggers = rest.filter((m) => m.type === 'TR');
  const procs = rest.filter((m) => m.type === 'P');
  // The catalog keeps the text of the last CREATE or ALTER, and of an object renamed with its old
  // name: the header says what it is now (CREATE, with the name it has).
  const header =
    /(?:CREATE\s+OR\s+ALTER|CREATE|ALTER)\s+(VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER)\s+(?:\[?\w+\]?\.)?\[?\w+\]?/i;
  return [...ordered, ...procs, ...triggers].map((m) => {
    const text = plain(m.def.trim());
    const at = header.exec(text);
    if (!at) throw new Error(`No CREATE header in the definition of ${m.name}`);
    // Any comment before the header is dropped.
    return `CREATE ${at[1]!.toUpperCase()} dbo.${m.name}${text.slice(at.index + at[0].length)}`;
  });
}

async function policies(db: Db): Promise<string[]> {
  const pol = await rows<{ id: number; name: string; enabled: boolean; bound: boolean }>(
    db,
    sql`SELECT object_id AS id, name, is_enabled AS enabled, is_schema_bound AS bound FROM sys.security_policies ORDER BY name`,
  );
  const out: string[] = [];
  for (const p of pol) {
    const preds = await rows<{ type: string; op: string | null; def: string; table: string }>(
      db,
      sql`SELECT predicate_type_desc AS type, operation_desc AS op, predicate_definition AS def, OBJECT_NAME(target_object_id) AS [table]
          FROM sys.security_predicates WHERE object_id = ${p.id} ORDER BY security_predicate_id`,
    );
    const lines = preds.map(
      (x) =>
        `  ADD ${x.type} PREDICATE ${plain(x.def).replace(/^\((.*)\)$/s, '$1')} ON dbo.${x.table}${x.type === 'BLOCK' && x.op ? ` ${x.op}` : ''}`,
    );
    out.push(
      `CREATE SECURITY POLICY dbo.${p.name}\n${lines.join(',\n')}\n  WITH (STATE = ${p.enabled ? 'ON' : 'OFF'}, SCHEMABINDING = ${p.bound ? 'ON' : 'OFF'});`,
    );
  }
  return out;
}

/** What the application's user may do on each object, one batch per object. */
async function permissions(db: Db, user: string): Promise<string[]> {
  const perms = await rows<{ state: string; permission: string; object: string }>(
    db,
    sql`SELECT p.state_desc AS state, p.permission_name AS permission, o.name AS [object]
        FROM sys.database_permissions p JOIN sys.objects o ON o.object_id = p.major_id
        WHERE p.class = 1 AND p.minor_id = 0 AND p.grantee_principal_id = DATABASE_PRINCIPAL_ID(${user})
          AND o.is_ms_shipped = 0
        ORDER BY o.name, p.state_desc, p.permission_name`,
  );
  const byObject = new Map<string, Map<string, string[]>>();
  for (const p of perms) {
    const states = byObject.get(p.object) ?? new Map<string, string[]>();
    states.set(p.state, [...(states.get(p.state) ?? []), p.permission]);
    byObject.set(p.object, states);
  }
  const out: string[] = [];
  for (const [object, states] of byObject) {
    const text: string[] = [];
    for (const [state, list] of states) {
      const verb = state === 'DENY' ? 'DENY' : 'GRANT';
      text.push(`${verb} ${list.join(', ')} ON dbo.${object} TO ${user};`);
    }
    out.push(text.join('\n'));
  }
  return out;
}

/** The baseline, from a database the migrations made with the default names (schema dbo). */
export async function baselineOf(adminUrl: string): Promise<string> {
  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    const [collation] = await rows<{ c: string }>(
      db,
      sql`SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS c`,
    );
    const files = migrationFiles();
    const batches = [
      ...(await tables(db, collation!.c)),
      ...(await foreignKeys(db)),
      ...(await indexes(db)),
      ...(await modules(db)),
      ...(await policies(db)),
      // The model's dimensions of the hierarchy are filled once, from the sources, as the migrations did.
      'EXEC dbo.bi_refrescar_dimensiones;',
      ...(await permissions(db, APP_USER)),
    ];
    return `-- The structure the migrations leave, as plain CREATE statements. Generated by
-- \`pnpm --filter @wansurvey/api db:baseline\`: do not edit it.
-- covers: ${files.map((f) => f.name).join(', ')}
${batches.join('\n--> statement-breakpoint\n')}
`;
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) {
    console.error(
      'DATABASE_ADMIN_URL: the owner of an empty database made contained (CREATE DATABASE x CONTAINMENT = PARTIAL)',
    );
    process.exit(1);
  }
  // A database made by the migrations with the default names (schema dbo, user wansurvey_app).
  await runMssqlMigrations(admin, `mssql://${APP_USER}:Baseline-Pass-1!x@x/x`, {
    schema: 'dbo',
    baseline: false,
  });
  writeFileSync(BASELINE_FILE, await baselineOf(admin));
  console.log(`Written to ${BASELINE_FILE}`);
}
