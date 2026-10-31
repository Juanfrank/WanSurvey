import { ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { mssqlNumber } from '../../src/db/mssql/connection.js';
import { Engine } from '../../src/db/engine.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  type MssqlTestApp,
} from './harness.js';

/** The counterpart of test/concurrency.test.ts: the database under concurrent use, on SQL Server. */
describe.skipIf(!configured)('SQL Server: the database under concurrent use', () => {
  let t: MssqlTestApp;
  let db: MssqlDatabase;
  let tenant: { id: string };

  beforeAll(async () => {
    t = await bootstrap();
    db = t.app.get(Engine).sql;
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('runs a transaction again after a deadlock, and reports it after the last try', async () => {
    let runs = 0;
    const out = await db.withTenant(tenant.id, async () => {
      runs++;
      if (runs === 1) throw Object.assign(new Error('deadlock victim'), { number: 1205 });
      return 'done';
    });
    expect(out).toBe('done');
    expect(runs).toBe(2);
    // Not forever.
    runs = 0;
    await expect(
      db.withTenant(tenant.id, async () => {
        runs++;
        throw Object.assign(new Error('deadlock victim'), { number: 1205 });
      }),
    ).rejects.toThrow('deadlock victim');
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(4);
  });

  it('answers 503 BUSY instead of waiting on a lock held too long', async () => {
    const project = await createProject(t.owner, tenant.id);
    // The same application user with a short wait for locks.
    const quick = new MssqlDatabase(process.env.MSSQL_URL!, { max: 2, lockTimeoutMs: 300 });
    // Someone else holds the row (a long transaction elsewhere).
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    const holder = t.owner.transaction().execute(async (x) => {
      await sql`UPDATE projects SET name = name WHERE id = ${project}`.execute(x);
      await held;
    });
    await new Promise((ok) => setTimeout(ok, 300));
    const started = Date.now();
    const err = await quick
      .withTenant(tenant.id, async (tx) => {
        await sql`UPDATE projects SET name = name WHERE id = ${project}`.execute(tx);
      })
      .catch((e: unknown) => e);
    release();
    await holder;
    await quick.destroy();
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'BUSY' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('hands every connection back to the pool, so a small pool serves any number of transactions', async () => {
    const small = new MssqlDatabase(process.env.MSSQL_URL!, { max: 2, lockTimeoutMs: 1000 });
    try {
      for (let i = 0; i < 20; i++)
        await small.withTenant(tenant.id, async (tx) => {
          await sql`SELECT 1 AS one`.execute(tx);
        });
    } finally {
      await small.destroy();
    }
  }, 30_000);

  it('pins the lock time limit and the tenant for the transaction only', async () => {
    const config = loadConfig();
    const inside = await db.withTenant(tenant.id, async (tx) => {
      const r = await sql<{ lt: number; tenant: string }>`
        SELECT @@LOCK_TIMEOUT AS lt, CAST(SESSION_CONTEXT(N'tenant_id') AS nvarchar(64)) AS tenant`.execute(
        tx,
      );
      return r.rows[0]!;
    });
    expect(inside.tenant.toLowerCase()).toBe(tenant.id);
    expect(Number(inside.lt)).toBe(config.DB_LOCK_TIMEOUT_MS);
    // The next transaction, on any connection, starts without a tenant.
    const after = await db.withTenant(tenant.id, async (tx) => {
      await sql`EXEC sp_set_session_context @key = N'tenant_id', @value = NULL`.execute(tx);
      const r = await sql<{ tenant: string | null }>`
        SELECT CAST(SESSION_CONTEXT(N'tenant_id') AS nvarchar(64)) AS tenant`.execute(tx);
      return r.rows[0]!.tenant;
    });
    expect(after).toBeNull();
  });

  it('finds the SQL Server number of a wrapped driver error', () => {
    expect(mssqlNumber({ cause: { number: 1205 } })).toBe(1205);
    expect(mssqlNumber(new Error('x'))).toBeUndefined();
  });

  it('keeps connections open longer than the load balancer', () => {
    const server = t.app.getHttpServer() as import('node:http').Server;
    const config = loadConfig();
    expect(server.keepAliveTimeout).toBe(config.HTTP_KEEPALIVE_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('does not mix up organisations when many transactions run at once', async () => {
    const orgs = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const o = await createTenant(t.owner);
        await createProject(t.owner, o.id);
        return o;
      }),
    );
    const seen = await Promise.all(
      Array.from({ length: 36 }, (_, i) => {
        const o = orgs[i % orgs.length]!;
        return db.withTenant(o.id, async (tx) => {
          const r = await sql<{
            tenant_id: string;
          }>`SELECT DISTINCT tenant_id FROM projects`.execute(tx);
          return { want: o.id, got: r.rows.map((x) => x.tenant_id.toLowerCase()) };
        });
      }),
    );
    for (const s of seen) expect(s.got).toEqual([s.want]);
  });
});
