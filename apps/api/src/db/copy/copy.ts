import { sql, type Kysely } from 'kysely';
import postgres from 'postgres';
import { createMssqlDb } from '../mssql/connection.js';

/**
 * Copies the data of a PostgreSQL database into the SQL Server database that holds the T-SQL
 * schema (docs/roadmap.md, phase 4). It reads both schemas, so it follows them as they change:
 * every table the two have in common is copied, column by column, converting each value to the
 * type SQL Server has for it. Rows travel as JSON and are inserted with OPENJSON, which gives every
 * column its exact target type in one statement per batch.
 *
 * The target must be empty (a new database that only the migrations have touched). The owner
 * connection is used on both sides: row-level security does not filter the owner.
 */

export interface CopyOptions {
  /** `postgres://…`, an owner of the source database. */
  sourceUrl: string;
  /** `mssql://…`, an owner of the target database (its migrations already applied). */
  targetUrl: string;
  /** Rows per statement (default 2000; fewer when rows are large). */
  batch?: number;
  /** Tables left out, by name. */
  skip?: string[];
  /** Only these tables, by name. */
  only?: string[];
  /** Copy into tables that already hold rows (default: refuse). */
  append?: boolean;
  log?: (message: string) => void;
}

export interface PgColumn {
  name: string;
  udt: string;
}
export interface MsColumn {
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
  nullable: boolean;
  computed: boolean;
  identity: boolean;
}
export interface TablePlan {
  table: string;
  /** Columns in both databases, in the target's order. */
  columns: { name: string; pg: PgColumn; ms: MsColumn; json: boolean }[];
  onlySource: string[];
  onlyTarget: string[];
}
export interface Plan {
  tables: TablePlan[];
  /** In PostgreSQL only (not copied). */
  sourceOnly: string[];
  /** In SQL Server only (left as the migrations made them). */
  targetOnly: string[];
}
export interface CopyReport {
  tables: { table: string; rows: number; ms: number; repaired: number }[];
  total: number;
  seconds: number;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const b = (name: string) => `[${name.replace(/]/g, ']]')}]`;

export function openSource(url: string) {
  return postgres(url, { max: 2, onnotice: () => {}, connect_timeout: 15 });
}
export function openTarget(url: string) {
  return createMssqlDb<Record<string, never>>(url, { max: 2, requestTimeoutMs: 0 });
}
type Target = Kysely<Record<string, never>>;
type Source = ReturnType<typeof openSource>;

export async function pgColumns(src: Source): Promise<Map<string, PgColumn[]>> {
  const rows = await src<{ table_name: string; column_name: string; udt_name: string }[]>`
    SELECT c.table_name, c.column_name, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`;
  const out = new Map<string, PgColumn[]>();
  for (const r of rows) {
    const list = out.get(r.table_name) ?? [];
    list.push({ name: r.column_name, udt: r.udt_name });
    out.set(r.table_name, list);
  }
  return out;
}

export async function msColumns(dst: Target): Promise<Map<string, MsColumn[]>> {
  const res = await sql<{
    tbl: string;
    col: string;
    type: string;
    max_length: number;
    precision: number;
    scale: number;
    is_nullable: boolean;
    is_computed: boolean;
    is_identity: boolean;
  }>`
    SELECT t.name AS tbl, c.name AS col, ty.name AS type, c.max_length, c.precision, c.scale,
           c.is_nullable, c.is_computed, c.is_identity
    FROM sys.tables t
    JOIN sys.columns c ON c.object_id = t.object_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
    ORDER BY t.name, c.column_id`.execute(dst);
  const out = new Map<string, MsColumn[]>();
  for (const r of res.rows) {
    const list = out.get(r.tbl) ?? [];
    list.push({
      name: r.col,
      type: r.type,
      maxLength: r.max_length,
      precision: r.precision,
      scale: r.scale,
      nullable: !!r.is_nullable,
      computed: !!r.is_computed,
      identity: !!r.is_identity,
    });
    out.set(r.tbl, list);
  }
  return out;
}

/** The columns SQL Server requires to hold JSON (a CHECK on ISJSON), as `table.column`. */
async function jsonColumns(dst: Target): Promise<Set<string>> {
  const res = await sql<{ tbl: string; col: string }>`
    SELECT t.name AS tbl, c.name AS col
    FROM sys.check_constraints cc
    JOIN sys.tables t ON t.object_id = cc.parent_object_id
    JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
    WHERE cc.definition LIKE '%isjson%'`.execute(dst);
  return new Set(res.rows.map((r) => `${r.tbl}.${r.col}`.toLowerCase()));
}

/** Tables with the tables they point to, so a parent is copied before its children. */
async function dependencies(dst: Target): Promise<Map<string, Set<string>>> {
  const res = await sql<{ child: string; parent: string }>`
    SELECT c.name AS child, p.name AS parent
    FROM sys.foreign_keys fk
    JOIN sys.tables c ON c.object_id = fk.parent_object_id
    JOIN sys.tables p ON p.object_id = fk.referenced_object_id`.execute(dst);
  const out = new Map<string, Set<string>>();
  for (const r of res.rows) {
    if (r.child === r.parent) continue;
    (out.get(r.child) ?? out.set(r.child, new Set()).get(r.child)!).add(r.parent);
  }
  return out;
}

function order(tables: string[], deps: Map<string, Set<string>>): string[] {
  const left = new Set(tables);
  const out: string[] = [];
  while (left.size) {
    const ready = [...left].filter((t) => [...(deps.get(t) ?? [])].every((d) => !left.has(d)));
    // A cycle (not expected) is cut anywhere: the constraints are off while the data loads.
    const next = (ready.length ? ready : [...left].slice(0, 1)).sort();
    for (const t of next) {
      out.push(t);
      left.delete(t);
    }
  }
  return out;
}

export async function plan(
  src: Source,
  dst: Target,
  opts: Pick<CopyOptions, 'skip' | 'only'> = {},
): Promise<Plan> {
  const [pg, ms, deps, json] = await Promise.all([
    pgColumns(src),
    msColumns(dst),
    dependencies(dst),
    jsonColumns(dst),
  ]);
  const skip = new Set(opts.skip ?? []);
  const only = opts.only?.length ? new Set(opts.only) : null;
  const common = [...ms.keys()].filter((t) => pg.has(t) && !skip.has(t) && (!only || only.has(t)));
  const tables: TablePlan[] = [];
  for (const table of order(common, deps)) {
    const pgCols = new Map(pg.get(table)!.map((c) => [c.name.toLowerCase(), c]));
    const msCols = ms.get(table)!;
    const columns: TablePlan['columns'] = [];
    const onlyTarget: string[] = [];
    for (const m of msCols) {
      const p = pgCols.get(m.name.toLowerCase());
      if (m.computed || m.identity || m.type === 'timestamp') continue;
      if (p)
        columns.push({
          name: m.name,
          pg: p,
          ms: m,
          json: json.has(`${table}.${m.name}`.toLowerCase()),
        });
      else onlyTarget.push(m.name);
    }
    const used = new Set(columns.map((c) => c.name.toLowerCase()));
    const onlySource = [...pgCols.values()]
      .map((c) => c.name)
      .filter((n) => !used.has(n.toLowerCase()));
    tables.push({ table, columns, onlySource, onlyTarget });
  }
  return {
    tables,
    sourceOnly: [...pg.keys()].filter((t) => !ms.has(t)).sort(),
    targetOnly: [...ms.keys()].filter((t) => !pg.has(t)).sort(),
  };
}

/** How a PostgreSQL column is selected: text (or an integer), whatever its type. */
export function selectExpr(c: PgColumn): string {
  const col = q(c.name);
  switch (c.udt) {
    case 'timestamptz':
      return `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case 'timestamp':
      return `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case 'bool':
      return `${col}::int`;
    case 'bytea':
      return `encode(${col}, 'hex')`;
    default:
      return c.udt.startsWith('_') ? `to_json(${col})::text` : `${col}::text`;
  }
}

/** The type OPENJSON reads a column as, and how it is turned into the stored type. */
export function openJsonType(m: MsColumn): { type: string; wrap?: (ref: string) => string } {
  switch (m.type) {
    case 'nvarchar':
    case 'varchar':
    case 'nchar':
    case 'char': {
      const unit = m.type.startsWith('n') ? 2 : 1;
      return { type: `${m.type}(${m.maxLength === -1 ? 'max' : m.maxLength / unit})` };
    }
    case 'datetimeoffset':
    case 'datetime2':
    case 'time':
      return { type: `${m.type}(${m.scale})` };
    case 'decimal':
    case 'numeric':
      return { type: `${m.type}(${m.precision},${m.scale})` };
    case 'float':
      return { type: 'float' };
    case 'varbinary':
    case 'binary':
      return { type: 'nvarchar(max)', wrap: (ref) => `CONVERT(varbinary(max), ${ref}, 2)` };
    default:
      return { type: m.type };
  }
}

async function count(dst: Target, table: string): Promise<number> {
  const r = await sql<{
    n: number;
  }>`SELECT COUNT_BIG(*) AS n FROM ${sql.raw('dbo.' + b(table))}`.execute(dst);
  return Number(r.rows[0]!.n);
}

/** Switches the foreign keys and check constraints of every table off, and later on again. */
async function constraints(dst: Target, tables: string[], on: boolean) {
  const failed: string[] = [];
  for (const t of tables) {
    try {
      await sql
        .raw(
          on
            ? `ALTER TABLE dbo.${b(t)} WITH CHECK CHECK CONSTRAINT ALL`
            : `ALTER TABLE dbo.${b(t)} NOCHECK CONSTRAINT ALL`,
        )
        .execute(dst);
    } catch (e) {
      if (!on) throw e;
      // Which rows break which constraint, rather than only that one does.
      const rows = (
        (await sql
          .raw(`DBCC CHECKCONSTRAINTS (N'dbo.${b(t)}') WITH ALL_ERRORMSGS`)
          .execute(dst)
          .catch(() => ({ rows: [] }))) as { rows: Record<string, unknown>[] }
      ).rows;
      failed.push(
        `${t}: ${(e as Error).message}` +
          rows
            .slice(0, 5)
            .map((r) => `\n    ${String(r.CONSTRAINT)} ${String(r.WHERE)}`)
            .join('') +
          (rows.length > 5 ? `\n    … and ${rows.length - 5} more` : ''),
      );
    }
  }
  if (failed.length)
    throw new Error(`Rows break constraints of SQL Server:\n  ${failed.join('\n  ')}`);
}

export async function copyData(opts: CopyOptions): Promise<CopyReport> {
  const log = opts.log ?? (() => undefined);
  const src = openSource(opts.sourceUrl);
  const dst = openTarget(opts.targetUrl);
  const started = Date.now();
  try {
    const p = await plan(src, dst, opts);
    if (!p.tables.length) throw new Error('No table is common to both databases');
    if (!opts.append) {
      const filled: string[] = [];
      for (const t of p.tables) if ((await count(dst, t.table)) > 0) filled.push(t.table);
      if (filled.length)
        throw new Error(
          `The target is not empty (${filled.slice(0, 5).join(', ')}${filled.length > 5 ? '…' : ''}). ` +
            'Use a new database that only the migrations have touched, or --append.',
        );
    }
    for (const t of p.tables) {
      if (t.onlySource.length)
        log(`${t.table}: not copied (not in SQL Server): ${t.onlySource.join(', ')}`);
    }
    const names = p.tables.map((t) => t.table);
    await constraints(dst, names, false);
    const report: CopyReport['tables'] = [];
    try {
      for (const t of p.tables) {
        const t0 = Date.now();
        const { rows, repaired } = await copyTable(src, dst, t, opts.batch ?? 2000);
        report.push({ table: t.table, rows, ms: Date.now() - t0, repaired });
        log(`${t.table}: ${rows} rows${repaired ? ` (${repaired} JSON values unwrapped)` : ''}`);
      }
    } finally {
      // Back on, and every row checked against them: a row whose parent is missing fails here.
      await constraints(dst, names, true);
    }
    const total = report.reduce((n, r) => n + r.rows, 0);
    return { tables: report, total, seconds: (Date.now() - started) / 1000 };
  } finally {
    await src.end({ timeout: 5 });
    await dst.destroy();
  }
}

/**
 * A JSON column that holds a JSON *string* whose text is itself a JSON object or array was written
 * twice-encoded (a value sent as text where JSON was meant). Where SQL Server requires JSON there,
 * the inner document is what was meant, and what is copied.
 */
export function unwrapJson(text: string | null): { text: string | null; changed: boolean } {
  if (text === null || !text.startsWith('"')) return { text, changed: false };
  try {
    const inner: unknown = JSON.parse(text);
    if (typeof inner !== 'string') return { text, changed: false };
    const parsed: unknown = JSON.parse(inner);
    if (parsed !== null && typeof parsed === 'object') return { text: inner, changed: true };
  } catch {
    // Not a document inside: copied as it is.
  }
  return { text, changed: false };
}

async function copyTable(
  src: Source,
  dst: Target,
  t: TablePlan,
  batch: number,
): Promise<{ rows: number; repaired: number }> {
  if (!t.columns.length) return { rows: 0, repaired: 0 };
  const repair = t.columns.filter((c) => c.json && (c.pg.udt === 'jsonb' || c.pg.udt === 'json'));
  let repaired = 0;
  const select = t.columns.map((c) => `${selectExpr(c.pg)} AS ${q(c.name)}`).join(', ');
  const names = t.columns.map((c) => b(c.name)).join(', ');
  const withClause = t.columns
    .map((c) => `${b(c.name)} ${openJsonType(c.ms).type} '$."${c.name}"'`)
    .join(', ');
  const refs = t.columns
    .map((c) => {
      const { wrap } = openJsonType(c.ms);
      return wrap ? wrap(b(c.name)) : b(c.name);
    })
    .join(', ');
  const insert = `INSERT INTO dbo.${b(t.table)} (${names}) SELECT ${refs} FROM OPENJSON(@p1) WITH (${withClause})`;
  let n = 0;
  let pending: unknown[] = [];
  let bytes = 0;
  // The statement takes the batch as a parameter; Kysely numbers its own, so the text is built
  // around the value with `sql` rather than replaced by hand.
  const run = async (rows: unknown[]) => {
    const json = JSON.stringify(rows);
    const [head, tail] = insert.split('@p1');
    await sql`${sql.raw(head!)}${json}${sql.raw(tail!)}`.execute(dst);
  };
  for await (const rows of src.unsafe(`SELECT ${select} FROM ${q(t.table)}`).cursor(batch)) {
    for (const r of rows) {
      for (const c of repair) {
        const u = unwrapJson((r as Record<string, string | null>)[c.name] ?? null);
        if (u.changed) {
          (r as Record<string, string | null>)[c.name] = u.text;
          repaired++;
        }
      }
      pending.push(r);
      bytes += JSON.stringify(r).length;
      if (pending.length >= batch || bytes > 8_000_000) {
        await run(pending);
        n += pending.length;
        pending = [];
        bytes = 0;
      }
    }
  }
  if (pending.length) {
    await run(pending);
    n += pending.length;
  }
  return { rows: n, repaired };
}
