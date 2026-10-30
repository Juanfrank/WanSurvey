import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityStore } from '../../src/auth/identity-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';

/**
 * What the sign-in service needs besides sessions and people, on SQL Server: second-factor codes
 * that work once (also when two race), links to an external identity, and an organisation's
 * Microsoft sign-in with its domains claimed one organisation at a time. Runs only where a
 * SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: sign-in identity', () => {
  let app: MssqlDatabase;
  const store = new IdentityStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `da-${stamp}` };
  const b = { id: randomUUID(), slug: `db-${stamp}` };
  const ana = randomUUID();
  const luis = randomUUID();

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 6 });
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      for (const t of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.slug}, ${t.slug})`.execute(
          db,
        );
      for (const [id, n] of [
        [ana, 'ana'],
        [luis, 'luis'],
      ] as const)
        await sql`INSERT INTO users (id, email, name, status, password_hash, totp_secret_enc, totp_enabled)
                  VALUES (${id}, ${`${n}-${stamp}@example.org`}, ${n}, 'active', 'hash', 'secret', 1)`.execute(
          db,
        );
    } finally {
      await db.destroy();
    }
  });
  afterAll(async () => {
    await app?.destroy();
  });

  it('reads the fields a password or a code is checked against', async () => {
    const c = await app.withUser(ana, (tx) => store.credentials(tx, ana));
    expect(c).toEqual({
      passwordHash: 'hash',
      totpSecretEnc: 'secret',
      totpEnabled: true,
      totpLastStep: null,
    });
    expect(await app.withUser(ana, (tx) => store.credentials(tx, randomUUID()))).toBeNull();
  });

  it('accepts a code’s step once, only forward, and once when two race', async () => {
    const accept = (step: number) => app.withUser(ana, (tx) => store.acceptTotpStep(tx, ana, step));
    expect(await accept(58_000_000_001)).toBe(true);
    expect(await accept(58_000_000_001)).toBe(false);
    expect(await accept(58_000_000_000)).toBe(false);
    expect((await app.withUser(ana, (tx) => store.credentials(tx, ana)))!.totpLastStep).toBe(
      58_000_000_001,
    );
    const race = await Promise.all(Array.from({ length: 5 }, () => accept(58_000_000_002)));
    expect(race.filter(Boolean)).toHaveLength(1);
    // Another account's steps are its own.
    expect(await app.withUser(luis, (tx) => store.acceptTotpStep(tx, luis, 5))).toBe(true);
  });

  it('links an external identity once, and finds the account by it', async () => {
    const issuer = `https://login.example/${stamp}/v2.0`;
    expect(await app.withUser(ana, (tx) => store.userByIdentity(tx, issuer, 'sub-1'))).toBeNull();
    await app.withUser(ana, (tx) =>
      store.linkIdentity(tx, { userId: ana, provider: 'entra', issuer, subject: 'sub-1' }),
    );
    expect(await app.withUser(luis, (tx) => store.userByIdentity(tx, issuer, 'sub-1'))).toBe(ana);
    await expect(
      app.withUser(luis, (tx) =>
        store.linkIdentity(tx, { userId: luis, provider: 'entra', issuer, subject: 'sub-1' }),
      ),
    ).rejects.toSatisfy(dup);
  });

  it('saves an organisation’s Microsoft sign-in, replacing it on a second save', async () => {
    expect(await app.withTenant(a.id, (tx) => store.sso(tx, a.id))).toBeNull();
    const first = await app.withTenant(a.id, (tx) =>
      store.saveSso(tx, a.id, {
        entraTenantId: 'entra-a',
        clientId: 'client-a',
        clientSecretEnc: 'enc-1',
        enabled: true,
        enforceSso: false,
        allowedDomains: ['acme.org'],
      }),
    );
    expect(first).toMatchObject({
      tenantId: a.id,
      entraTenantId: 'entra-a',
      clientSecretEnc: 'enc-1',
      enabled: true,
      enforceSso: false,
      allowedDomains: ['acme.org'],
    });
    const second = await app.withTenant(a.id, (tx) =>
      store.saveSso(tx, a.id, {
        ...first,
        clientSecretEnc: null,
        enforceSso: true,
        allowedDomains: ['acme.org', 'acme.com'],
      }),
    );
    expect(second).toMatchObject({
      clientSecretEnc: null,
      enforceSso: true,
      allowedDomains: ['acme.org', 'acme.com'],
    });
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await app.withTenant(b.id, (tx) => store.sso(tx, a.id))).toBeNull();
  });

  it('tells who claims a domain, and lets one organisation save its domains at a time', async () => {
    expect(await app.withTenant(b.id, (tx) => store.domainOwners(tx, 'ACME.org'))).toEqual([a.id]);
    expect(await app.withTenant(b.id, (tx) => store.domainOwners(tx, 'free.org'))).toEqual([]);
    // The second organisation waits for the first to commit, then sees its domain taken.
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    const first = app.withTenant(a.id, async (tx) => {
      await store.lockSsoDomains(tx);
      order.push('a locked');
      await held;
      order.push('a done');
    });
    await new Promise((ok) => setTimeout(ok, 300));
    const second = app.withTenant(b.id, async (tx) => {
      await store.lockSsoDomains(tx);
      order.push('b locked');
    });
    await new Promise((ok) => setTimeout(ok, 300));
    expect(order).toEqual(['a locked']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a locked', 'a done', 'b locked']);
  });
});
