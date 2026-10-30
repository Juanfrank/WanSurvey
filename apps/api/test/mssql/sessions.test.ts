import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionsStore } from '../../src/auth/sessions-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';

/**
 * Sessions and one-time tokens on SQL Server: opening a session as the person, finding it by its
 * token with the person's standing and roles, touching and revoking, the second-factor state,
 * revoking everywhere, and tokens that work once even when two race. Runs only where a SQL Server
 * is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: sessions and tokens', () => {
  let app: MssqlDatabase;
  const store = new SessionsStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `sa-${stamp}` };
  const b = { id: randomUUID(), slug: `sb-${stamp}` };
  const ana = randomUUID();
  const project = randomUUID();
  const hour = () => new Date(Date.now() + 3_600_000);

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
  const open = (tenant: string, token: string, over: Record<string, unknown> = {}) =>
    app.withTenant(
      tenant,
      (tx) =>
        store.open(tx, {
          tenantId: tenant,
          userId: ana,
          tokenHash: token,
          csrfToken: 'csrf',
          mfaState: 'ok',
          mfaMethod: null,
          authMethod: 'password',
          idpTenant: null,
          ip: '10.0.0.1',
          userAgent: 'UA',
          expiresAt: hour(),
          lastTenantId: null,
          ...over,
        }),
      ana,
    );

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 6 });
    await owner(async (db) => {
      for (const t of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.slug}, ${t.slug})`.execute(
          db,
        );
      await sql`UPDATE tenants SET role_permissions = '{"interviewer":["cases.read"]}' WHERE id = ${a.id}`.execute(
        db,
      );
      await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${project}, ${a.id}, 'P', ${'P-' + stamp})`.execute(
        db,
      );
      await sql`INSERT INTO users (id, email, name, status) VALUES (${ana}, ${`ana-${stamp}@example.org`}, 'Ana', 'active')`.execute(
        db,
      );
      for (const t of [a.id, b.id])
        await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${randomUUID()}, ${t}, ${ana}, 'active')`.execute(
          db,
        );
      await sql`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (${randomUUID()}, ${a.id}, ${ana}, 'interviewer')`.execute(
        db,
      );
      await sql`INSERT INTO memberships (id, tenant_id, user_id, role, project_id) VALUES (${randomUUID()}, ${a.id}, ${ana}, 'reviewer', ${project})`.execute(
        db,
      );
    });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  it('opens a session and finds it by its token, with the person, standing, changes and roles', async () => {
    const id = await open(a.id, 'hash-1', { mfaState: 'ok', mfaMethod: 'totp' });
    const s = await app.withTenant(a.id, (tx) => store.byToken(tx, 'hash-1'));
    expect(s).toMatchObject({
      id,
      tenantId: a.id,
      userId: ana,
      csrfToken: 'csrf',
      mfaState: 'ok',
      mfaMethod: 'totp',
      authMethod: 'password',
      email: `ana-${stamp}@example.org`,
      userStatus: 'active',
      memberStatus: 'active',
      rolePermissions: { interviewer: ['cases.read'] },
    });
    expect(s!.grants).toEqual(
      expect.arrayContaining([
        { role: 'interviewer', projectId: null },
        { role: 'reviewer', projectId: project },
      ]),
    );
    expect(s!.grants).toHaveLength(2);
    expect(s!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await app.withTenant(a.id, (tx) => store.byToken(tx, 'nope'))).toBeNull();
  });

  it('keeps the organisation opened last, and a session visible only in its own organisation', async () => {
    await open(b.id, 'hash-b', { lastTenantId: a.id });
    const last = await owner(
      async (db) =>
        (
          await sql<{ t: string }>`SELECT last_tenant_id AS t FROM users WHERE id = ${ana}`.execute(
            db,
          )
        ).rows[0]!.t,
    );
    expect(last.toLowerCase()).toBe(b.id);
    expect(await app.withTenant(a.id, (tx) => store.byToken(tx, 'hash-b'))).toBeNull();
    expect(await app.withTenant(b.id, (tx) => store.byToken(tx, 'hash-b'))).not.toBeNull();
  });

  it('touches, changes the second-factor state, and revokes', async () => {
    const id = await open(a.id, 'hash-2', { mfaState: 'pending' });
    const later = new Date(Date.now() + 60_000);
    await app.withTenant(a.id, (tx) => store.touch(tx, id, later));
    await app.withTenant(a.id, (tx) => store.setMfa(tx, id, { state: 'ok', method: 'totp' }));
    const s = await app.withTenant(a.id, (tx) => store.byToken(tx, 'hash-2'));
    expect(s).toMatchObject({ mfaState: 'ok', mfaMethod: 'totp' });
    expect(s!.lastSeenAt.getTime()).toBe(later.getTime());
    await app.withTenant(a.id, (tx) => store.revoke(tx, id));
    expect(await app.withTenant(a.id, (tx) => store.byToken(tx, 'hash-2'))).toBeNull();
  });

  it('revokes all of a person’s sessions in the organisation, or in every one', async () => {
    await open(a.id, 'hash-3');
    await open(a.id, 'hash-4');
    await open(b.id, 'hash-5');
    const n = await app.withTenant(a.id, (tx) => store.revokeAllOf(tx, ana));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await app.withTenant(a.id, (tx) => store.byToken(tx, 'hash-3'))).toBeNull();
    expect(await app.withTenant(b.id, (tx) => store.byToken(tx, 'hash-5'))).not.toBeNull();
    const all = await app.withTenant(b.id, (tx) => store.revokeEverywhere(tx, ana));
    expect(all).toBeGreaterThanOrEqual(1);
    expect(await app.withTenant(b.id, (tx) => store.byToken(tx, 'hash-5'))).toBeNull();
  });

  it('works tokens once, also when two race, and not after they expire', async () => {
    const issue = (hash: string, over: Record<string, unknown> = {}) =>
      app.withUser(ana, (tx) =>
        store.issueToken(tx, {
          tenantId: null,
          userId: ana,
          purpose: 'password_reset',
          tokenHash: hash,
          expiresAt: hour(),
          ...over,
        }),
      );
    await issue('t-1');
    expect(await app.withUser(ana, (tx) => store.peekToken(tx, 't-1', 'password_reset'))).toEqual({
      userId: ana,
      tenantId: null,
    });
    expect(await app.withUser(ana, (tx) => store.peekToken(tx, 't-1', 'invitation'))).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => app.withUser(ana, (tx) => store.useToken(tx, 't-1'))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await app.withUser(ana, (tx) => store.peekToken(tx, 't-1', 'password_reset')),
    ).toBeNull();

    await issue('t-old', { expiresAt: new Date(Date.now() - 1000) });
    expect(await app.withUser(ana, (tx) => store.useToken(tx, 't-old'))).toBe(false);

    await issue('t-inv', { purpose: 'invitation', tenantId: a.id });
    expect(await app.withUser(ana, (tx) => store.peekToken(tx, 't-inv', 'invitation'))).toEqual({
      userId: ana,
      tenantId: a.id,
    });
    await app.withUser(ana, (tx) => store.voidTokens(tx, ana, 'invitation'));
    expect(await app.withUser(ana, (tx) => store.peekToken(tx, 't-inv', 'invitation'))).toBeNull();
  });
});
