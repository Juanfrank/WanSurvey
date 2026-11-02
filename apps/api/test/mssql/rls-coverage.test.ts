import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, configured, type MssqlTestApp } from './harness.js';

/** Tables with a tenant_id that are deliberately outside the row-level policy, and why. */
const OUTSIDE_POLICY: Record<string, string> = {
  user_tokens:
    'global one-time tokens (reset, invitation) looked up before any organisation is known',
};

describe.skipIf(!configured)('SQL Server: row-level security coverage', () => {
  let t: MssqlTestApp;
  beforeAll(async () => {
    t = await bootstrap();
  });

  it('every table with a tenant_id has a security predicate, or is allowlisted with a reason', async () => {
    const tables = await sql<{ name: string }>`
      SELECT DISTINCT o.name
      FROM sys.columns c
      JOIN sys.objects o ON o.object_id = c.object_id AND o.type = 'U'
      WHERE c.name = 'tenant_id' AND SCHEMA_NAME(o.schema_id) = 'dbo'`.execute(t.owner);
    const guarded = await sql<{ name: string }>`
      SELECT DISTINCT o.name
      FROM sys.security_predicates p
      JOIN sys.objects o ON o.object_id = p.target_object_id
      JOIN sys.security_policies sp ON sp.object_id = p.object_id AND sp.is_enabled = 1`.execute(
      t.owner,
    );
    const guardedSet = new Set(guarded.rows.map((r) => r.name));
    const missing = tables.rows
      .map((r) => r.name)
      .filter((n) => !guardedSet.has(n) && !(n in OUTSIDE_POLICY));
    expect(missing).toEqual([]);
    // An allowlist entry that has since been guarded is a stale exception.
    expect(Object.keys(OUTSIDE_POLICY).filter((n) => guardedSet.has(n))).toEqual([]);
  });
});
