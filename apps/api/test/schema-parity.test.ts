import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every column of the PostgreSQL schema (src/db/schema.ts) exists in the T-SQL migrations
 * (mssql/), until PostgreSQL is retired. The first T-SQL migrations had followed an older schema
 * (accounts per organisation, no project settings); this keeps any column added to PostgreSQL
 * from being left out of SQL Server. It reads the files only: no database is needed.
 */
const ROOT = join(import.meta.dirname, '..');
const TYPES =
  'text|uuid|boolean|integer|bigint|timestamp|jsonb|doublePrecision|smallint|real|varchar|bytea|numeric|date';

function pgColumns(): Map<string, Set<string>> {
  const src = readFileSync(join(ROOT, 'src/db/schema.ts'), 'utf8');
  const tables = new Map<string, Set<string>>();
  for (const m of src.matchAll(/pgTable\(\s*'([a-z_]+)'\s*,\s*\{/g)) {
    let depth = 1;
    let j = m.index! + m[0].length;
    const start = j;
    while (depth) {
      const c = src[j++];
      depth += (c === '{' ? 1 : 0) - (c === '}' ? 1 : 0);
    }
    const body = src.slice(start, j - 1);
    const cols = new Set(
      [...body.matchAll(new RegExp(`(?:${TYPES})\\(\\s*'([a-z_0-9]+)'`, 'g'))].map((x) => x[1]!),
    );
    if (/^\s*id:\s*id\(\)/m.test(body)) cols.add('id');
    if (/:\s*tenantId\(\)/.test(body)) cols.add('tenant_id');
    if (/:\s*createdAt\(\)/.test(body)) cols.add('created_at');
    tables.set(m[1]!, cols);
  }
  return tables;
}

function mssqlColumns(): Map<string, Set<string>> {
  const dir = join(ROOT, 'mssql');
  const txt = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  const tables = new Map<string, Set<string>>();
  const column =
    /^\s*\[?([a-z_0-9]+)\]?\s+(?:uniqueidentifier|nvarchar|varchar|bit|int|bigint|smallint|float|decimal|datetimeoffset|datetime2|varbinary|date|char|AS)\b/;
  for (const m of txt.matchAll(/CREATE TABLE (?:dbo\.|bi\.)?([a-z_]+)\s*\(/g)) {
    let depth = 1;
    let j = m.index! + m[0].length;
    const start = j;
    while (depth) {
      const c = txt[j++];
      depth += (c === '(' ? 1 : 0) - (c === ')' ? 1 : 0);
    }
    const cols = new Set<string>();
    for (const line of txt.slice(start, j - 1).split('\n')) {
      const x = column.exec(line);
      if (x) cols.add(x[1]!);
    }
    tables.set(m[1]!, cols);
  }
  for (const m of txt.matchAll(
    /ALTER TABLE (?:dbo\.)?([a-z_]+)\s+ADD\b(.*?)(?:;\n|--> statement)/gs,
  ))
    for (const x of m[2]!.matchAll(
      /(?:^|,|\n)\s*\[?([a-z_0-9]+)\]?\s+(?:uniqueidentifier|nvarchar|bit|int|bigint|datetimeoffset|varbinary|float)/g,
    )) {
      if (!tables.has(m[1]!)) tables.set(m[1]!, new Set());
      tables.get(m[1]!)!.add(x[1]!);
    }
  for (const m of txt.matchAll(/ALTER TABLE (?:dbo\.)?([a-z_]+)\s+DROP COLUMN ([a-z_, ]+);/g))
    for (const c of m[2]!.trim().split(/,\s*/)) tables.get(m[1]!)?.delete(c);
  return tables;
}

describe('schema parity: PostgreSQL and T-SQL', () => {
  const pg = pgColumns();
  const ms = mssqlColumns();

  it('reads the schema (a guard against the check going vacuous)', () => {
    expect(pg.size).toBeGreaterThanOrEqual(50);
    expect([...pg.values()].reduce((n, c) => n + c.size, 0)).toBeGreaterThan(400);
    expect(pg.get('projects')).toContain('settings');
    expect(ms.get('tenant_members')).toContain('status');
  });

  it('has every table of PostgreSQL in T-SQL', () => {
    expect([...pg.keys()].filter((t) => !ms.has(t))).toEqual([]);
  });

  it.each([...pgColumns().keys()].sort())('has every column of %s', (table) => {
    const missing = [...(pg.get(table) ?? [])].filter((c) => !ms.get(table)?.has(c));
    expect(missing).toEqual([]);
  });
});
