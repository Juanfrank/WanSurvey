import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';

/**
 * Identity on SQL Server (mssql/0011): global accounts seen through an organisation's member
 * list, changed only by the person themselves, the sign-in procedures that run before any
 * context (lookup, organisations, lockout, session revocation, SSO), and the per-organisation
 * SSO settings. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: identity', () => {
  let app: MssqlDatabase;
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `ia-${stamp}`, name: 'Alfa' };
  const b = { id: randomUUID(), slug: `ib-${stamp}`, name: 'Beta' };
  const ana = randomUUID();
  const luis = randomUUID();
  const solo = randomUUID();
  const email = (n: string) => `${n}-${stamp}@Example.org`;

  const owner = async <T>(
    fn: (db: ReturnType<typeof createMssqlDb<Record<string, never>>>) => Promise<T>,
  ) => {
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      return await fn(db);
    } finally {
      await db.destroy();
    }
  };
  const call = async <T>(query: ReturnType<typeof sql<T>>) => (await query.execute(app.db)).rows;

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 4 });
    await owner(async (db) => {
      for (const t of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.name}, ${t.slug})`.execute(
          db,
        );
      for (const [id, n, status] of [
        [ana, 'ana', 'active'],
        [luis, 'luis', 'active'],
        [solo, 'solo', 'pending'],
      ] as const)
        await sql`INSERT INTO users (id, email, name, status, password_hash) VALUES (${id}, ${email(n)}, ${n}, ${status}, 'h')`.execute(
          db,
        );
      // Ana belongs to both organisations, Luis to the first only, and Solo to none.
      for (const [t, u, st] of [
        [a.id, ana, 'active'],
        [b.id, ana, 'deactivated'],
        [a.id, luis, 'active'],
      ] as const)
        await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${randomUUID()}, ${t}, ${u}, ${st})`.execute(
          db,
        );
    });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  it('shows an organisation the people on its member list, and only them', async () => {
    const names = (tenant: string) =>
      app.withTenant(tenant, async (tx) =>
        (await tx.selectFrom('users').select('name').orderBy('name').execute()).map((u) => u.name),
      );
    expect(await names(a.id)).toEqual(expect.arrayContaining(['ana', 'luis']));
    expect(await names(a.id)).not.toContain('solo');
    expect(await names(b.id)).toContain('ana');
    expect(await names(b.id)).not.toContain('luis');
  });

  it('lets a person change only their own account', async () => {
    await app.withTenant(
      a.id,
      async (tx) => {
        await tx.updateTable('users').set({ name: 'Ana M.' }).where('id', '=', ana).execute();
      },
      ana,
    );
    const seen = (tenant: string) =>
      app.withTenant(
        tenant,
        async (tx) =>
          (await tx.selectFrom('users').select('name').where('id', '=', ana).executeTakeFirst())
            ?.name,
      );
    expect(await seen(a.id)).toBe('Ana M.');
    // Someone else's account: no row is touched (it is not even theirs to see changed).
    await app
      .withTenant(
        a.id,
        async (tx) => {
          await tx.updateTable('users').set({ name: 'x' }).where('id', '=', luis).execute();
        },
        ana,
      )
      .catch(() => undefined);
    const luisName = await app.withTenant(
      a.id,
      async (tx) =>
        (await tx.selectFrom('users').select('name').where('id', '=', luis).executeTakeFirst())
          ?.name,
    );
    expect(luisName).toBe('luis');
    // Without the person in context an update is refused by the policy.
    await expect(
      app.withTenant(a.id, async (tx) => {
        await tx.updateTable('users').set({ name: 'y' }).where('id', '=', ana).execute();
      }),
    ).rejects.toThrow();
    // The account alone, with no organisation.
    await app.withUser(solo, async (tx) => {
      expect(
        (await tx.selectFrom('users').select('name').where('id', '=', solo).executeTakeFirst())
          ?.name,
      ).toBe('solo');
      expect(await tx.selectFrom('users').select('id').where('id', '=', ana).execute()).toEqual([]);
    });
  });

  it('finds an account by e-mail whatever the case, before any context', async () => {
    const r = await call(
      sql<{ id: string; status: string }>`EXEC dbo.auth_user_by_email ${email('ANA')}`,
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.id.toLowerCase()).toBe(ana);
    expect(await call(sql`EXEC dbo.auth_user_by_email ${'nobody@example.org'}`)).toEqual([]);
    const id = await call(sql<{ id: string }>`EXEC dbo.user_id_by_email ${email('luis')}`);
    expect(id[0]!.id.toLowerCase()).toBe(luis);
  });

  it('lists the organisations of a person: active ones, or all of them', async () => {
    const active = await call(sql<{ slug: string }>`EXEC dbo.user_tenants ${ana}, 0`);
    expect(active.map((t) => t.slug)).toEqual([a.slug]);
    const all = await call(
      sql<{ slug: string; member_status: string }>`EXEC dbo.user_tenants ${ana}, 1`,
    );
    expect(all.map((t) => [t.slug, t.member_status])).toEqual([
      [a.slug, 'active'],
      [b.slug, 'deactivated'],
    ]);
    expect(await call(sql`EXEC dbo.user_tenants ${solo}, 1`)).toEqual([]);
  });

  it('locks an account after repeated failures and unlocks it on success', async () => {
    const failed = async () =>
      (await call(sql<{ until: Date | null }>`EXEC dbo.account_failed ${luis}, 3, 600`))[0]
        ?.until ?? null;
    const lockedUntil = async () =>
      (await call(sql<{ until: Date }>`EXEC dbo.account_locked_until ${luis}`))[0]?.until ?? null;
    expect(await lockedUntil()).toBeNull();
    expect(await failed()).toBeNull();
    expect(await failed()).toBeNull();
    const until = await failed();
    expect(until).toBeInstanceOf(Date);
    expect(until!.getTime()).toBeGreaterThan(Date.now() + 500_000);
    expect((await lockedUntil())!.getTime()).toBe(until!.getTime());
    await call(sql`EXEC dbo.account_succeeded ${luis}`);
    expect(await lockedUntil()).toBeNull();
    // The count started again: two failures do not lock.
    expect(await failed()).toBeNull();
    expect(await failed()).toBeNull();
    await call(sql`EXEC dbo.account_succeeded ${luis}`);
  });

  it('revokes every session of a person, in every organisation', async () => {
    await owner(async (db) => {
      for (const t of [a.id, b.id])
        await sql`INSERT INTO sessions (id, tenant_id, user_id, token_hash, csrf_token, mfa_state, expires_at)
                  VALUES (${randomUUID()}, ${t}, ${ana}, ${randomUUID()}, 'c', 'ok', DATEADD(hour, 1, SYSDATETIMEOFFSET()))`.execute(
          db,
        );
    });
    const n = await call(sql<{ n: number }>`EXEC dbo.revoke_user_sessions ${ana}`);
    expect(n[0]!.n).toBe(2);
    expect((await call(sql<{ n: number }>`EXEC dbo.revoke_user_sessions ${ana}`))[0]!.n).toBe(0);
  });

  it('keeps tokens global: no organisation needed', async () => {
    await app.withUser(ana, async (tx) => {
      await tx
        .insertInto('user_tokens')
        .values({
          id: randomUUID(),
          tenant_id: null,
          user_id: ana,
          purpose: 'password_reset',
          token_hash: randomUUID(),
          expires_at: new Date(Date.now() + 3_600_000),
        })
        .execute();
    });
  });

  it('keeps SSO settings per organisation, and lets sign-in find them without context', async () => {
    await app.withTenant(a.id, async (tx) => {
      await tx
        .insertInto('tenant_sso')
        .values({
          tenant_id: a.id,
          entra_tenant_id: 'entra-a',
          client_id: 'client-a',
          enabled: true,
          enforce_sso: true,
          allowed_domains: JSON.stringify(['acme.org', 'acme.com']),
        })
        .execute();
    });
    expect(
      await app.withTenant(b.id, (tx) => tx.selectFrom('tenant_sso').selectAll().execute()),
    ).toEqual([]);
    const bySlug = await call(sql<{ entra_tenant_id: string; client_id: string; enabled: boolean }>`
      EXEC dbo.sso_config_by_slug ${a.slug.toUpperCase()}`);
    expect(bySlug).toMatchObject([
      { entra_tenant_id: 'entra-a', client_id: 'client-a', enabled: true },
    ]);
    const byDomain = await call(
      sql<{ slug: string }>`EXEC dbo.sso_tenants_for_domain ${'ACME.com'}`,
    );
    expect(byDomain.map((r) => r.slug)).toEqual([a.slug]);
    expect(await call(sql`EXEC dbo.sso_tenants_for_domain ${'other.org'}`)).toEqual([]);
    const enforced = await call(sql<{ tenant_id: string; entra_tenant_id: string }>`
      EXEC dbo.sso_enforced_tenants ${JSON.stringify([a.id, b.id])}`);
    expect(enforced.map((r) => [r.tenant_id.toLowerCase(), r.entra_tenant_id])).toEqual([
      [a.id, 'entra-a'],
    ]);
  });

  it('links an external identity once', async () => {
    const link = (user: string) =>
      app.withUser(user, (tx) =>
        tx
          .insertInto('user_identities')
          .values({
            id: randomUUID(),
            user_id: user,
            provider: 'entra',
            issuer: `iss-${stamp}`,
            subject: 'sub-1',
          })
          .execute(),
      );
    await link(ana);
    await expect(link(luis)).rejects.toSatisfy((e) =>
      [2601, 2627].includes((e as { number?: number }).number ?? 0),
    );
  });
});
