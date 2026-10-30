import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';

/** The test database, made through `master` when the server does not have it yet. */
async function ensureDatabase(adminUrl: string): Promise<void> {
  const url = new URL(adminUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/master';
  const master = createMssqlDb<Record<string, never>>(url.toString(), { max: 1 });
  try {
    await sql
      .raw(
        `IF DB_ID(N'${name.replace(/'/g, "''")}') IS NULL CREATE DATABASE [${name.replace(/]/g, ']]')}]`,
      )
      .execute(master);
  } finally {
    await master.destroy();
  }
}

/**
 * Organisation isolation on SQL Server (mssql/0001: security policy on SESSION_CONTEXT). Runs
 * only where a SQL Server is given: MSSQL_ADMIN_URL (an owner of an empty database such as
 * `mssql://sa:…@localhost:1433/wansurvey_test?trustServerCertificate=true`) and MSSQL_URL
 * (the same database as `wansurvey_app`).
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: isolation by organisation', () => {
  let app: MssqlDatabase;
  const a = { id: randomUUID(), slug: `a-${Date.now().toString(36)}` };
  const b = { id: randomUUID(), slug: `b-${Date.now().toString(36)}` };

  beforeAll(async () => {
    await ensureDatabase(ADMIN!);
    await runMssqlMigrations(ADMIN!, APP!);
    // Twice: the second finds nothing left to do.
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 4 });
    // The owner is not filtered, as the migrations and the seed are not.
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    for (const t of [a, b])
      await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.slug}, ${t.slug})`.execute(
        owner,
      );
    await owner.destroy();
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const project = (tenantId: string, code: string) => ({
    id: randomUUID(),
    tenant_id: tenantId,
    name: code,
    code,
    modes_enabled: '[]',
    languages: '["es"]',
  });

  it('shows an organisation only its own rows', async () => {
    await app.withTenant(a.id, (tx) =>
      tx.insertInto('projects').values(project(a.id, 'PA')).execute(),
    );
    await app.withTenant(b.id, (tx) =>
      tx.insertInto('projects').values(project(b.id, 'PB')).execute(),
    );
    const seenByA = await app.withTenant(a.id, (tx) =>
      tx.selectFrom('projects').select('code').execute(),
    );
    expect(seenByA.map((r) => r.code)).toEqual(['PA']);
    const tenants = await app.withTenant(b.id, (tx) =>
      tx.selectFrom('tenants').select('slug').execute(),
    );
    expect(tenants.map((r) => r.slug)).toEqual([b.slug]);
  });

  it('shows nothing without a context, and nothing leaks between transactions', async () => {
    expect(await app.db.selectFrom('projects').select('code').execute()).toEqual([]);
    // Many transactions of both organisations through a pool of 4 connections.
    const seen = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const t = i % 2 ? a : b;
        return app
          .withTenant(t.id, (tx) => tx.selectFrom('projects').select('code').execute())
          .then((rows) => [t === a ? 'PA' : 'PB', rows.map((r) => r.code)] as const);
      }),
    );
    for (const [want, got] of seen) expect(got).toEqual([want]);
    expect(await app.db.selectFrom('projects').select('code').execute()).toEqual([]);
  });

  it('refuses to write another organisation’s rows, new or changed', async () => {
    await expect(
      app.withTenant(a.id, (tx) =>
        tx.insertInto('projects').values(project(b.id, 'EVIL')).execute(),
      ),
    ).rejects.toThrow();
    await expect(
      app.withTenant(a.id, (tx) =>
        tx.updateTable('projects').set({ tenant_id: b.id }).where('code', '=', 'PA').execute(),
      ),
    ).rejects.toThrow();
    // Updating or deleting what it cannot see touches nothing.
    const res = await app.withTenant(a.id, (tx) =>
      tx.updateTable('projects').set({ name: 'x' }).where('code', '=', 'PB').executeTakeFirst(),
    );
    expect(Number(res.numUpdatedRows)).toBe(0);
  });

  it('rolls back a failed transaction and keeps the context off the next one', async () => {
    await expect(
      app.withTenant(a.id, async (tx) => {
        await tx.insertInto('projects').values(project(a.id, 'GONE')).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const codes = await app.withTenant(a.id, (tx) =>
      tx.selectFrom('projects').select('code').execute(),
    );
    expect(codes.map((r) => r.code)).toEqual(['PA']);
  });

  it('finds an organisation by slug before any context, through the owner procedure', async () => {
    expect(await app.tenantIdBySlug(a.slug.toUpperCase())).toBe(a.id);
    expect(await app.tenantIdBySlug('nobody')).toBeNull();
  });

  it('keeps the audit log append-only: no privilege for the application, a trigger for the owner', async () => {
    const id = randomUUID();
    await app.withTenant(a.id, (tx) =>
      tx
        .insertInto('audit_log')
        .values({
          id,
          tenant_id: a.id,
          actor_user_id: null,
          action: 'x',
          target_type: null,
          target_id: null,
          details: '{}',
        })
        .execute(),
    );
    await expect(
      app.withTenant(a.id, (tx) =>
        tx.updateTable('audit_log').set({ action: 'y' }).where('id', '=', id).execute(),
      ),
    ).rejects.toThrow(/permission was denied/i);
    await expect(
      app.withTenant(a.id, (tx) => sql`DELETE FROM audit_log WHERE id = ${id}`.execute(tx)),
    ).rejects.toThrow(/permission was denied/i);
    // The owner has the privilege, and the trigger still refuses.
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await expect(
        sql`UPDATE audit_log SET action = 'y' WHERE id = ${id}`.execute(owner),
      ).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM audit_log WHERE id = ${id}`.execute(owner)).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await owner.destroy();
    }
  });

  it('rejects an invalid organisation id before touching the database', async () => {
    await expect(app.withTenant('not-a-uuid', async () => 1)).rejects.toThrow('Invalid tenant id');
  });

  it('does not let the application user change the schema or the policy', async () => {
    await expect(
      app.withTenant(a.id, (tx) =>
        sql`ALTER SECURITY POLICY rls.tenant_isolation WITH (STATE = OFF)`.execute(tx),
      ),
    ).rejects.toThrow();
    await expect(
      app.withTenant(a.id, (tx) => sql`DROP TABLE projects`.execute(tx)),
    ).rejects.toThrow();
  });
});
