import { stableStringify } from '@wansurvey/logic';
import { sql } from 'kysely';
import {
  openSource,
  openTarget,
  plan,
  selectExpr,
  unwrapJson,
  type CopyOptions,
  type TablePlan,
} from './copy.js';

/**
 * Checks a copy against its source: the rows of every table counted on both sides; where the table
 * has an `id`, a fingerprint of all the ids; and a pseudo-random sample of rows compared field by
 * field after both sides are put in the same form (instants in UTC to the millisecond, JSON as
 * values, numbers as numbers).
 */
export interface VerifyOptions extends Pick<
  CopyOptions,
  'sourceUrl' | 'targetUrl' | 'skip' | 'only' | 'log'
> {
  /** Rows compared per table (default 100). */
  sample?: number;
  /** Tables above this many rows are not fingerprinted (default 300 000). */
  fingerprintLimit?: number;
}

export interface TableCheck {
  table: string;
  source: number;
  target: number;
  fingerprint: 'same' | 'different' | 'skipped';
  sampled: number;
  mismatches: string[];
}
export interface VerifyReport {
  ok: boolean;
  tables: TableCheck[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const b = (name: string) => `[${name.replace(/]/g, ']]')}]`;

/** A column of SQL Server as text, in the form PostgreSQL's `selectExpr` gives. */
function msExpr(c: TablePlan['columns'][number]): string {
  const col = b(c.name);
  switch (c.ms.type) {
    case 'uniqueidentifier':
      return `LOWER(CAST(${col} AS varchar(36)))`;
    case 'datetimeoffset':
      return `CONVERT(varchar(40), SWITCHOFFSET(${col}, '+00:00'), 127)`;
    case 'datetime2':
      return `CONVERT(varchar(40), ${col}, 127) + 'Z'`;
    case 'date':
      return `CONVERT(varchar(10), ${col}, 23)`;
    case 'bit':
      return `CAST(${col} AS int)`;
    case 'varbinary':
    case 'binary':
      return `LOWER(CONVERT(varchar(max), ${col}, 2))`;
    case 'float':
    case 'real':
      return `CONVERT(varchar(64), ${col}, 3)`;
    default:
      return `CAST(${col} AS nvarchar(max))`;
  }
}

const isJson = (udt: string) => udt === 'jsonb' || udt === 'json' || udt.startsWith('_');
const isNumber = (udt: string) =>
  ['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(udt);

function same(udt: string, a: unknown, b_: unknown, repaired = false): boolean {
  if (a === null || a === undefined) return b_ === null || b_ === undefined;
  if (b_ === null || b_ === undefined) return false;
  if (isJson(udt)) {
    // Twice-encoded JSON was unwrapped by the copy where SQL Server requires a document.
    if (repaired) a = unwrapJson(String(a)).text;
    try {
      return stableStringify(JSON.parse(String(a))) === stableStringify(JSON.parse(String(b_)));
    } catch {
      return false;
    }
  }
  if (isNumber(udt)) return Number(a) === Number(b_);
  // The same instant, however many zeros SQL Server writes after the seconds.
  if (udt === 'timestamptz' || udt === 'timestamp')
    return Date.parse(String(a)) === Date.parse(String(b_));
  return String(a) === String(b_);
}

export async function verifyCopy(opts: VerifyOptions): Promise<VerifyReport> {
  const src = openSource(opts.sourceUrl);
  const dst = openTarget(opts.targetUrl);
  const log = opts.log ?? (() => undefined);
  try {
    const p = await plan(src, dst, opts);
    const out: TableCheck[] = [];
    for (const t of p.tables) {
      const check: TableCheck = {
        table: t.table,
        source: 0,
        target: 0,
        fingerprint: 'skipped',
        sampled: 0,
        mismatches: [],
      };
      check.source = Number(
        (await src.unsafe(`SELECT count(*)::int AS n FROM ${q(t.table)}`))[0]!.n,
      );
      check.target = Number(
        (
          await sql<{
            n: number;
          }>`SELECT COUNT_BIG(*) AS n FROM ${sql.raw('dbo.' + b(t.table))}`.execute(dst)
        ).rows[0]!.n,
      );
      if (check.source !== check.target)
        check.mismatches.push(`rows: ${check.source} in PostgreSQL, ${check.target} in SQL Server`);

      const id = t.columns.find((c) => c.name === 'id');
      if (id && check.source > 0) {
        if (check.source <= (opts.fingerprintLimit ?? 300_000)) {
          const a = (
            await src.unsafe(
              `SELECT md5(coalesce(string_agg(lower(id::text), ',' ORDER BY lower(id::text) COLLATE "C"), '')) AS h FROM ${q(t.table)}`,
            )
          )[0]!.h as string;
          const m = (
            await sql<{ h: string }>`
              SELECT LOWER(CONVERT(varchar(32), HASHBYTES('MD5', CAST(ISNULL(STRING_AGG(CAST(LOWER(CAST(id AS varchar(450))) AS varchar(max)), ',')
                WITHIN GROUP (ORDER BY LOWER(CAST(id AS varchar(450))) COLLATE Latin1_General_BIN2), '') AS varchar(max))), 2)) AS h
              FROM ${sql.raw('dbo.' + b(t.table))}`.execute(dst)
          ).rows[0]!.h;
          check.fingerprint = a === m ? 'same' : 'different';
          if (a !== m) check.mismatches.push('the set of ids differs');
        }
        // The sample: the same rows on both sides, chosen by a hash of the id.
        const ids = (
          await src.unsafe(
            `SELECT id::text AS id FROM ${q(t.table)} ORDER BY md5(id::text) LIMIT ${opts.sample ?? 100}`,
          )
        ).map((r) => String(r.id));
        if (ids.length) {
          const pgRows = await src.unsafe(
            `SELECT ${t.columns.map((c) => `${selectExpr(c.pg)} AS ${q(c.name)}`).join(', ')} FROM ${q(t.table)} WHERE id::text = ANY($1)`,
            [ids],
          );
          const list = sql.join(ids.map((i) => sql.lit(i)));
          const msRows = (
            await sql<Record<string, unknown>>`
              SELECT ${sql.raw(t.columns.map((c) => `${msExpr(c)} AS ${b(c.name)}`).join(', '))}
              FROM ${sql.raw('dbo.' + b(t.table))}
              WHERE LOWER(CAST(id AS varchar(450))) IN (${list})`.execute(dst)
          ).rows;
          const byId = new Map(msRows.map((r) => [String(r.id).toLowerCase(), r]));
          for (const r of pgRows) {
            const other = byId.get(String(r.id).toLowerCase());
            check.sampled++;
            if (!other) {
              check.mismatches.push(`row ${String(r.id)} is missing in SQL Server`);
              continue;
            }
            for (const c of t.columns)
              if (!same(c.pg.udt, r[c.name], other[c.name], c.json) && check.mismatches.length < 10)
                check.mismatches.push(
                  `${String(r.id)}.${c.name}: ${JSON.stringify(r[c.name])?.slice(0, 80)} ≠ ${JSON.stringify(other[c.name])?.slice(0, 80)}`,
                );
          }
        }
      }
      out.push(check);
      log(
        `${t.table}: ${check.source}/${check.target} rows, ids ${check.fingerprint}, ${check.sampled} sampled${check.mismatches.length ? ', ' + check.mismatches.length + ' PROBLEM(S)' : ''}`,
      );
    }
    return { ok: out.every((c) => !c.mismatches.length), tables: out };
  } finally {
    await src.end({ timeout: 5 });
    await dst.destroy();
  }
}
