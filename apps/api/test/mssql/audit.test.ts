import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { AuditStore } from '../../src/audit/audit-store.mssql.js';

/**
 * The audit log on SQL Server: entries written with the change, read newest first with the
 * filters of the audit screen, never changed or deleted, and seen only by their organisation.
 * Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: audit log', () => {
  let app: MssqlDatabase;
  const store = new AuditStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `ua-${stamp}` };
  const b = { id: randomUUID(), slug: `ub-${stamp}` };
  const ana = randomUUID();
  const luis = randomUUID();

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 4 });
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      for (const x of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${x.id}, ${x.slug}, ${x.slug})`.execute(
          db,
        );
    } finally {
      await db.destroy();
    }
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const write = (tenant: string, entry: Parameters<AuditStore['record']>[2]) =>
    app.withTenant(tenant, (tx) => store.record(tx, tenant, entry));
  const pause = () => new Promise((ok) => setTimeout(ok, 15));

  it('records entries with their details, and lists the newest first', async () => {
    await write(a.id, { action: 'auth.login', actorUserId: ana, ip: '10.0.0.1', userAgent: 'UA' });
    await pause();
    await write(a.id, {
      action: 'team.created',
      actorUserId: luis,
      targetType: 'team',
      targetId: 'T1',
      details: { name: 'Norte', members: 3 },
    });
    await pause();
    await write(a.id, { action: 'auth.login', actorUserId: luis });
    const all = await app.withTenant(a.id, (tx) => store.list(tx, { limit: 100 }));
    expect(all.map((e) => e.action)).toEqual(['auth.login', 'team.created', 'auth.login']);
    expect(all[1]).toMatchObject({
      tenantId: a.id,
      actorUserId: luis,
      targetType: 'team',
      targetId: 'T1',
      details: { name: 'Norte', members: 3 },
    });
    expect(all[2]).toMatchObject({
      actorUserId: ana,
      ip: '10.0.0.1',
      userAgent: 'UA',
      details: {},
    });
    expect(all[0]!.at.getTime()).toBeGreaterThan(all[2]!.at.getTime());
  });

  it('filters by action, actor, target and time, and limits', async () => {
    const list = (f: Partial<Parameters<AuditStore['list']>[1]>) =>
      app.withTenant(a.id, (tx) => store.list(tx, { limit: 100, ...f }));
    expect(await list({ action: 'auth.login' })).toHaveLength(2);
    expect(await list({ actorUserId: luis })).toHaveLength(2);
    expect(await list({ targetId: 'T1' })).toHaveLength(1);
    expect(await list({ limit: 1 })).toHaveLength(1);
    const all = await list({});
    const mid = all[1]!.at;
    expect(await list({ from: mid })).toHaveLength(2);
    expect(await list({ to: mid })).toHaveLength(2);
    expect(await list({ from: new Date(Date.now() + 60_000) })).toHaveLength(0);
  });

  it('is seen only by its organisation, and is append-only', async () => {
    await write(b.id, { action: 'auth.login' });
    expect(await app.withTenant(b.id, (tx) => store.list(tx, { limit: 100 }))).toHaveLength(1);
    expect(await app.withTenant(a.id, (tx) => store.list(tx, { limit: 100 }))).toHaveLength(3);
    // Writing for another organisation is refused by the policy.
    await expect(
      write(b.id, { action: 'auth.login' }).then(() =>
        app.withTenant(a.id, (tx) => store.record(tx, b.id, { action: 'auth.login' })),
      ),
    ).rejects.toThrow();
    // The application has no privilege to change or delete entries.
    await expect(
      app.withTenant(a.id, async (tx) => {
        await sql`UPDATE audit_log SET action = 'x'`.execute(tx);
      }),
    ).rejects.toThrow(/permission/i);
    await expect(
      app.withTenant(a.id, async (tx) => {
        await sql`DELETE FROM audit_log`.execute(tx);
      }),
    ).rejects.toThrow(/permission/i);
  });
});
