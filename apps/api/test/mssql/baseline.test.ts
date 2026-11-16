import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { loadBaseline, migrationFiles, runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { ADMIN_URL, APP_URL, configured } from './harness.js';

type Db = Kysely<Record<string, never>>;
const rows = async <T>(db: Db, q: ReturnType<typeof sql>) =>
  ((await q.execute(db)) as { rows: T[] }).rows;

/** Everything of the structure that can be read from the catalog, as sorted lines. */
async function describeDatabase(db: Db): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  // Constraints SQL Server named by itself carry a random suffix: only their kind is compared.
  const generic = (l: string) =>
    l.replace(
      /\b(?:(PK|UQ|DF|CK|FK)__\w+|(pk|uq|df|ck|fk)_\w+(?=\|))/g,
      (_m, a?: string, b?: string) => `${(a ?? b)!.toUpperCase()}__*`,
    );
  const put = (k: string, lines: string[]) => (out[k] = lines.map(generic).sort());
  put(
    'objects',
    (
      await rows<{ t: string; n: string }>(
        db,
        sql`SELECT RTRIM(type) AS t, name AS n FROM sys.objects WHERE is_ms_shipped = 0 AND type NOT IN ('D','PK','UQ','C','F') AND name <> '__migrations'`,
      )
    ).map((r) => `${r.t} ${r.n}`),
  );
  put(
    'columns',
    (
      await rows<Record<string, unknown>>(
        db,
        sql`SELECT OBJECT_NAME(c.object_id) AS tbl, c.column_id AS id, c.name, t.name AS type, c.max_length AS len, c.precision AS p, c.scale AS s,
              c.is_nullable AS nul, c.is_identity AS idn, c.collation_name AS col, cc.definition AS comp, d.name AS dfn, d.definition AS df
            FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
            JOIN sys.objects o ON o.object_id = c.object_id AND o.type IN ('U', 'V')
            LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
            LEFT JOIN sys.default_constraints d ON d.parent_object_id = c.object_id AND d.parent_column_id = c.column_id
            WHERE o.name <> '__migrations'`,
      )
    )
      // The position of a column in its table, not its number (a dropped column leaves a gap).
      .sort((a, b) => String(a.tbl).localeCompare(String(b.tbl)) || Number(a.id) - Number(b.id))
      .map((r, i, all) => {
        const rank = all.slice(0, i).filter((x) => x.tbl === r.tbl).length + 1;
        return Object.values({ ...r, id: rank }).join('|');
      }),
  );
  put(
    'checks',
    (
      await rows<{ n: string; t: string; d: string }>(
        db,
        sql`SELECT name AS n, OBJECT_NAME(parent_object_id) AS t, definition AS d FROM sys.check_constraints`,
      )
    ).map((r) => `${r.n}|${r.t}|${r.d}`),
  );
  const ix = await rows<Record<string, unknown>>(
    db,
    sql`SELECT i.name AS n, OBJECT_NAME(i.object_id) AS t, i.type AS ty, i.is_primary_key AS pk, i.is_unique_constraint AS uq, i.is_unique AS u,
          i.filter_definition AS f, i.fill_factor AS ff, i.is_padded AS pad, i.ignore_dup_key AS idk, i.object_id AS oid, i.index_id AS iid
        FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U' WHERE i.type > 0 AND o.name <> '__migrations'`,
  );
  const ixc = await rows<{
    oid: number;
    iid: number;
    c: string;
    d: boolean;
    inc: boolean;
    k: number;
    ord: number;
  }>(
    db,
    sql`SELECT ic.object_id AS oid, ic.index_id AS iid, c.name AS c, ic.is_descending_key AS d, ic.is_included_column AS inc, ic.key_ordinal AS k, ic.index_column_id AS ord
        FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id`,
  );
  put(
    'indexes',
    ix.map((i) => {
      const cols = ixc
        .filter((c) => c.oid === i.oid && c.iid === i.iid)
        .sort((a, b) => Number(a.inc) - Number(b.inc) || a.k - b.k || a.ord - b.ord)
        .map((c) => `${c.c}${c.d ? ' D' : ''}${c.inc ? ' I' : ''}`);
      return [i.n, i.t, i.ty, i.pk, i.uq, i.u, i.f, i.ff, i.pad, i.idk, cols.join(',')].join('|');
    }),
  );
  const fks = await rows<{ n: string; c: string; r: string; del: string; upd: string; id: number }>(
    db,
    sql`SELECT name AS n, OBJECT_NAME(parent_object_id) AS c, OBJECT_NAME(referenced_object_id) AS r, delete_referential_action_desc AS del, update_referential_action_desc AS upd, object_id AS id
        FROM sys.foreign_keys WHERE OBJECT_NAME(parent_object_id) <> '__migrations'`,
  );
  const fkc = await rows<{ id: number; p: string; r: string; o: number }>(
    db,
    sql`SELECT k.constraint_object_id AS id, pc.name AS p, rc.name AS r, k.constraint_column_id AS o FROM sys.foreign_key_columns k
        JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id
        JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id`,
  );
  put(
    'foreign keys',
    fks.map(
      (f) =>
        `${f.n}|${f.c}|${f.r}|${f.del}|${f.upd}|${fkc
          .filter((c) => c.id === f.id)
          .sort((a, b) => a.o - b.o)
          .map((c) => `${c.p}>${c.r}`)
          .join(',')}`,
    ),
  );
  // The text of every module, without its header (the catalog keeps the old name of a renamed one) and layout.
  const header =
    /(?:CREATE\s+OR\s+ALTER|CREATE|ALTER)\s+(?:VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER)\s+(?:\[?\w+\]?\.)?\[?\w+\]?/i;
  put(
    'modules',
    (
      await rows<{ n: string; d: string }>(
        db,
        sql`SELECT o.name AS n, m.definition AS d FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id WHERE o.is_ms_shipped = 0`,
      )
    ).map((m) => {
      const at = header.exec(m.d)!;
      return `${m.n}|${m.d
        .slice(at.index + at[0].length)
        .replace(/\s+/g, ' ')
        .trim()}`;
    }),
  );
  put(
    'triggers',
    (
      await rows<{ n: string; t: string; i: boolean; d: boolean }>(
        db,
        sql`SELECT name AS n, OBJECT_NAME(parent_id) AS t, is_instead_of_trigger AS i, is_disabled AS d FROM sys.triggers`,
      )
    ).map((r) => `${r.n}|${r.t}|${r.i}|${r.d}`),
  );
  const pol = await rows<{ id: number; n: string; e: boolean; b: boolean }>(
    db,
    sql`SELECT object_id AS id, name AS n, is_enabled AS e, is_schema_bound AS b FROM sys.security_policies`,
  );
  const preds = await rows<{ id: number; ty: string; op: string | null; t: string; d: string }>(
    db,
    sql`SELECT object_id AS id, predicate_type_desc AS ty, operation_desc AS op, OBJECT_NAME(target_object_id) AS t, predicate_definition AS d FROM sys.security_predicates`,
  );
  put(
    'policies',
    pol.map(
      (p) =>
        `${p.n}|${p.e}|${p.b}|${preds
          .filter((x) => x.id === p.id)
          .map((x) => `${x.ty}:${x.op ?? ''}:${x.t}:${x.d}`)
          .sort()
          .join(';')}`,
    ),
  );
  put(
    'permissions',
    (
      await rows<{ s: string; p: string; c: number; o: string | null; m: number }>(
        db,
        sql`SELECT state_desc AS s, permission_name AS p, class AS c, OBJECT_NAME(major_id) AS o, minor_id AS m FROM sys.database_permissions
            WHERE USER_NAME(grantee_principal_id) = 'wansurvey_app'`,
      )
    ).map((r) => `${r.s}|${r.p}|${r.c}|${r.o ?? ''}|${r.m}`),
  );
  put(
    'rows',
    (
      await rows<{ t: string; n: number }>(
        db,
        sql`SELECT OBJECT_NAME(object_id) AS t, SUM(rows) AS n FROM sys.partitions WHERE index_id IN (0, 1)
            AND OBJECTPROPERTY(object_id, 'IsUserTable') = 1 AND OBJECT_NAME(object_id) <> '__migrations' GROUP BY object_id HAVING SUM(rows) > 0`,
      )
    ).map((r) => `${r.t}|${r.n}`),
  );
  put(
    'migrations',
    (await rows<{ name: string }>(db, sql`SELECT name FROM dbo.__migrations`)).map((r) => r.name),
  );
  return out;
}

describe.skipIf(!configured)(
  'SQL Server: the baseline and the migrations make the same database',
  () => {
    const stamp = Date.now().toString(36);
    const names = [`ws_base_a_${stamp}`, `ws_base_b_${stamp}`];
    const at = (database: string) => {
      const u = new URL(ADMIN_URL!);
      u.pathname = `/${database}`;
      return u.toString();
    };
    const appAt = (database: string) => {
      const u = new URL(APP_URL!);
      u.pathname = `/${database}`;
      return u.toString();
    };
    const master = createMssqlDb<Record<string, never>>(at('master'), { max: 1 });
    let replay: Record<string, string[]>;
    let fromBaseline: Record<string, string[]>;

    beforeAll(async () => {
      for (const n of names)
        await sql.raw(`CREATE DATABASE [${n}] CONTAINMENT = PARTIAL`).execute(master);
      await runMssqlMigrations(at(names[0]!), appAt(names[0]!), { baseline: false });
      await runMssqlMigrations(at(names[1]!), appAt(names[1]!));
      const a = createMssqlDb<Record<string, never>>(at(names[0]!), { max: 1 });
      const b = createMssqlDb<Record<string, never>>(at(names[1]!), { max: 1 });
      try {
        replay = await describeDatabase(a);
        fromBaseline = await describeDatabase(b);
      } finally {
        await a.destroy();
        await b.destroy();
      }
    }, 300_000);
    afterAll(async () => {
      for (const n of names) {
        await sql
          .raw(`ALTER DATABASE [${n}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
          .execute(master);
        await sql.raw(`DROP DATABASE [${n}]`).execute(master);
      }
      await master.destroy();
    });

    it('has a baseline that covers migrations of this repository', () => {
      const base = loadBaseline();
      expect(base).not.toBeNull();
      const all = migrationFiles().map((f) => f.name);
      // What it covers is a prefix of the migrations; the rest are applied after it.
      expect(base!.covers).toEqual(all.slice(0, base!.covers.length));
      expect(base!.batches.length).toBeGreaterThan(100);
      // No history in it: only CREATE statements, the one EXEC that fills the dimensions, and permissions.
      for (const b of base!.batches)
        expect(b).not.toMatch(
          /^\s*(ALTER\s+(PROCEDURE|VIEW)|ALTER\s+TABLE\s+\S+\s+(ADD(?!\s+CONSTRAINT)|ALTER|DROP)|UPDATE|DELETE|sp_rename)\b/i,
        );
    });

    for (const key of [
      'objects',
      'columns',
      'checks',
      'indexes',
      'foreign keys',
      'modules',
      'triggers',
      'policies',
      'permissions',
      'rows',
      'migrations',
    ])
      it(`makes the same ${key}`, () => {
        expect(fromBaseline[key]).toEqual(replay[key]);
        expect(replay[key]!.length).toBeGreaterThan(0);
      });
  },
);
