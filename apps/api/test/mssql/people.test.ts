import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { PeopleStore } from '../../src/users/people-store.mssql.js';

/**
 * The people of an organisation on SQL Server: inviting a new account or linking an existing one,
 * roles replaced as a set, standing in the organisation, and the account fields only the person
 * changes. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: people', () => {
  let app: MssqlDatabase;
  const store = new PeopleStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `pa-${stamp}`, project: randomUUID() };
  const b = { id: randomUUID(), slug: `pb-${stamp}` };
  const luis = randomUUID();
  const eva = randomUUID();
  const mail = (n: string) => `${n}-${stamp}@example.org`;

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

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 4 });
    await owner(async (db) => {
      for (const t of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.slug}, ${t.slug})`.execute(
          db,
        );
      await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${a.project}, ${a.id}, 'P', ${'P-' + stamp})`.execute(
        db,
      );
    });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const invite = (
    tenant: string,
    userId: string,
    name: string,
    existing = false,
    grants = [{ role: 'interviewer', projectId: null as string | null }],
  ) =>
    app.withTenant(tenant, (tx) =>
      store.invite(tx, {
        tenantId: tenant,
        userId,
        email: mail(name.toLowerCase()),
        name,
        idCode: `ID-${name}`,
        languages: ['es'],
        grants,
        existing,
      }),
    );

  it('invites a new account: invited, with its roles, unseen by other organisations', async () => {
    await invite(a.id, luis, 'Luis');
    const m = await app.withTenant(a.id, (tx) => store.member(tx, luis));
    expect(m).toMatchObject({
      id: luis,
      email: mail('luis'),
      name: 'Luis',
      languages: ['es'],
      status: 'invited',
      idCode: 'ID-Luis',
      userStatus: 'pending',
      totpEnabled: false,
      deactivatedAt: null,
    });
    expect(await app.withTenant(a.id, (tx) => store.grants(tx, luis))).toEqual([
      { userId: luis, role: 'interviewer', projectId: null },
    ]);
    expect(await app.withTenant(b.id, (tx) => store.member(tx, luis))).toBeNull();
  });

  it('links an existing account to another organisation instead of duplicating it', async () => {
    await invite(b.id, luis, 'Luis', true, [{ role: 'reviewer', projectId: null }]);
    const inB = await app.withTenant(b.id, (tx) => store.members(tx));
    expect(inB.map((x) => x.id)).toEqual([luis]);
    // One account, two organisations, each with its own roles.
    expect((await app.withTenant(a.id, (tx) => store.grants(tx, luis)))[0]!.role).toBe(
      'interviewer',
    );
    expect((await app.withTenant(b.id, (tx) => store.grants(tx, luis)))[0]!.role).toBe('reviewer');
    await expect(invite(a.id, randomUUID(), 'Luis')).rejects.toSatisfy(dup);
    await expect(invite(a.id, luis, 'Luis', true)).rejects.toSatisfy(dup);
  });

  it('lists members by name with everyone’s roles, and replaces a person’s roles as a set', async () => {
    await invite(a.id, eva, 'Eva', false, [{ role: 'supervisor', projectId: a.project }]);
    const members = await app.withTenant(a.id, (tx) => store.members(tx));
    expect(members.map((x) => x.name)).toEqual(['Eva', 'Luis']);
    expect(
      (await app.withTenant(a.id, (tx) => store.grants(tx))).map((g) => g.role).sort(),
    ).toEqual(['interviewer', 'supervisor']);
    await app.withTenant(a.id, (tx) =>
      store.setGrants(tx, a.id, luis, [
        { role: 'reviewer', projectId: null },
        { role: 'interviewer', projectId: a.project },
      ]),
    );
    const g = await app.withTenant(a.id, (tx) => store.grants(tx, luis));
    expect(g.map((x) => [x.role, x.projectId]).sort()).toEqual([
      ['interviewer', a.project],
      ['reviewer', null],
    ]);
    await app.withTenant(a.id, (tx) => store.setGrants(tx, a.id, luis, []));
    expect(await app.withTenant(a.id, (tx) => store.grants(tx, luis))).toEqual([]);
    expect(
      await app.withTenant(a.id, (tx) => store.existingProjects(tx, [a.project, randomUUID()])),
    ).toEqual([a.project]);
  });

  it('changes standing in the organisation and the organisation’s own fields', async () => {
    await app.withTenant(a.id, (tx) => store.setMemberStatus(tx, luis, 'active'));
    expect((await app.withTenant(a.id, (tx) => store.member(tx, luis)))!.status).toBe('active');
    await app.withTenant(a.id, (tx) => store.setMemberStatus(tx, luis, 'deactivated'));
    const off = await app.withTenant(a.id, (tx) => store.member(tx, luis));
    expect(off!.status).toBe('deactivated');
    expect(off!.deactivatedAt).toBeInstanceOf(Date);
    await app.withTenant(a.id, (tx) => store.setMemberStatus(tx, luis, 'active'));
    expect((await app.withTenant(a.id, (tx) => store.member(tx, luis)))!.deactivatedAt).toBeNull();
    // Deactivated in one organisation, still invited in the other.
    await app.withTenant(a.id, (tx) =>
      store.updateMember(tx, luis, { idCode: 'X-1', phoneExtension: '204' }),
    );
    expect(await app.withTenant(a.id, (tx) => store.member(tx, luis))).toMatchObject({
      idCode: 'X-1',
      phoneExtension: '204',
    });
    expect((await app.withTenant(b.id, (tx) => store.member(tx, luis)))!.idCode).toBe('ID-Luis');
  });

  it('lets a person change their own account, and only them', async () => {
    await app.withTenant(
      a.id,
      (tx) =>
        store.updateAccount(tx, luis, {
          name: 'Luis P.',
          phone: '555',
          languages: ['en', 'es'],
          status: 'active',
          passwordHash: 'hash',
          totpEnabled: true,
        }),
      luis,
    );
    expect(await app.withTenant(a.id, (tx) => store.member(tx, luis))).toMatchObject({
      name: 'Luis P.',
      phone: '555',
      languages: ['en', 'es'],
      userStatus: 'active',
      totpEnabled: true,
    });
    // The same person is seen as such in the other organisation.
    expect((await app.withTenant(b.id, (tx) => store.member(tx, luis)))!.name).toBe('Luis P.');
    // Another person (or nobody) cannot change it.
    await expect(
      app.withTenant(a.id, (tx) => store.updateAccount(tx, luis, { name: 'Hacked' }), eva),
    ).rejects.toThrow();
    await expect(
      app.withTenant(a.id, (tx) => store.updateAccount(tx, luis, { name: 'Hacked' })),
    ).rejects.toThrow();
    expect((await app.withTenant(a.id, (tx) => store.member(tx, luis)))!.name).toBe('Luis P.');
  });
});
