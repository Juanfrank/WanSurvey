import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { ProjectsStore } from '../../src/projects/projects-store.mssql.js';

/**
 * Organisations and projects on SQL Server: the organisation's own settings and role changes,
 * projects with their settings merged on update, codes once per organisation, logos stored apart
 * from the project row, and isolation by organisation. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: organisations and projects', () => {
  let app: MssqlDatabase;
  const store = new ProjectsStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `ja-${stamp}` };
  const b = { id: randomUUID(), slug: `jb-${stamp}` };

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 4 });
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      for (const t of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.slug}, ${t.slug})`.execute(
          db,
        );
    } finally {
      await db.destroy();
    }
  });
  afterAll(async () => {
    await app?.destroy();
  });

  it('reads the organisation in context, and merges settings on update', async () => {
    const t = await app.withTenant(a.id, (tx) => store.tenant(tx, a.id));
    expect(t).toMatchObject({
      id: a.id.toUpperCase(),
      plan: 'trial',
      settings: {},
      role_permissions: {},
    });
    await app.withTenant(a.id, (tx) =>
      store.updateTenant(tx, a.id, {
        settings: { defaultLanguage: 'es', defaultTimezone: 'America/Guatemala' },
      }),
    );
    const after = await app.withTenant(a.id, (tx) =>
      store.updateTenant(tx, a.id, { name: 'Alfa', settings: { defaultLanguage: 'en' } }),
    );
    expect(after).toMatchObject({
      name: 'Alfa',
      settings: { defaultLanguage: 'en', defaultTimezone: 'America/Guatemala' },
    });
    // Another organisation's row is not there to read or change.
    expect(await app.withTenant(b.id, (tx) => store.tenant(tx, a.id))).toBeNull();
    expect(
      await app.withTenant(b.id, (tx) => store.updateTenant(tx, a.id, { name: 'x' })),
    ).toBeNull();
  });

  it('keeps what an organisation changed in its roles, and returns what was before', async () => {
    const before = await app.withTenant(a.id, (tx) =>
      store.setRolePermissions(tx, a.id, { interviewer: ['cases.read'] }),
    );
    expect(before).toEqual({});
    const second = await app.withTenant(a.id, (tx) => store.setRolePermissions(tx, a.id, {}));
    expect(second).toEqual({ interviewer: ['cases.read'] });
    expect((await app.withTenant(a.id, (tx) => store.tenant(tx, a.id)))!.role_permissions).toEqual(
      {},
    );
  });

  it('creates projects with defaults, lists them by name, and keeps codes once per organisation', async () => {
    const p = await app.withTenant(a.id, (tx) =>
      store.create(tx, { tenantId: a.id, name: 'Zeta', code: 'Z-1', modesEnabled: ['CATI'] }),
    );
    expect(p).toMatchObject({
      name: 'Zeta',
      code: 'Z-1',
      status: 'draft',
      timezone: 'UTC',
      modes_enabled: ['CATI'],
      languages: ['es'],
      settings: {},
      logo_updated_at: null,
    });
    await app.withTenant(a.id, (tx) =>
      store.create(tx, {
        tenantId: a.id,
        name: 'Alfa',
        code: 'A-1',
        timezone: 'America/Guatemala',
        languages: ['es', 'en'],
      }),
    );
    expect((await app.withTenant(a.id, (tx) => store.list(tx))).map((x) => x.name)).toEqual([
      'Alfa',
      'Zeta',
    ]);
    expect(await app.withTenant(a.id, (tx) => store.codeTaken(tx, 'Z-1'))).toBe(true);
    expect(await app.withTenant(a.id, (tx) => store.codeTaken(tx, 'Q-9'))).toBe(false);
    await expect(
      app.withTenant(a.id, (tx) => store.create(tx, { tenantId: a.id, name: 'Otra', code: 'Z-1' })),
    ).rejects.toSatisfy(dup);
    // The same code in another organisation is fine.
    await app.withTenant(b.id, (tx) =>
      store.create(tx, { tenantId: b.id, name: 'Z', code: 'Z-1' }),
    );
    expect(await app.withTenant(b.id, (tx) => store.list(tx))).toHaveLength(1);
  });

  it('lists only some projects, gets one, and merges settings on update', async () => {
    const all = await app.withTenant(a.id, (tx) => store.list(tx));
    const zeta = all.find((x) => x.name === 'Zeta')!;
    expect(
      (await app.withTenant(a.id, (tx) => store.list(tx, [zeta.id]))).map((x) => x.name),
    ).toEqual(['Zeta']);
    expect(await app.withTenant(a.id, (tx) => store.list(tx, []))).toEqual([]);
    expect(await app.withTenant(b.id, (tx) => store.get(tx, zeta.id))).toBeNull();

    await app.withTenant(a.id, (tx) =>
      store.update(tx, zeta.id, { settings: { goal: 100, review: { sample: 0.1 } } }),
    );
    const u = await app.withTenant(a.id, (tx) =>
      store.update(tx, zeta.id, {
        status: 'active',
        timezone: 'Europe/Madrid',
        settings: { goal: 200 },
      }),
    );
    expect(u).toMatchObject({
      status: 'active',
      timezone: 'Europe/Madrid',
      settings: { goal: 200, review: { sample: 0.1 } },
    });
    expect(
      await app.withTenant(a.id, (tx) => store.update(tx, randomUUID(), { name: 'x' })),
    ).toBeNull();
  });

  it('keeps a logo apart from the project, replaces it, and removes it', async () => {
    const [zeta] = (await app.withTenant(a.id, (tx) => store.list(tx))).filter(
      (x) => x.name === 'Zeta',
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
    const at = await app.withTenant(a.id, (tx) =>
      store.setLogo(tx, {
        projectId: zeta!.id,
        tenantId: a.id,
        contentType: 'image/png',
        image: png,
      }),
    );
    const logo = await app.withTenant(a.id, (tx) => store.logo(tx, zeta!.id));
    expect(logo!.contentType).toBe('image/png');
    expect(Buffer.compare(logo!.image, png)).toBe(0);
    expect(
      (await app.withTenant(a.id, (tx) => store.get(tx, zeta!.id)))!.logo_updated_at,
    ).toBeInstanceOf(Date);
    expect(at).toBeInstanceOf(Date);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 9]);
    await app.withTenant(a.id, (tx) =>
      store.setLogo(tx, {
        projectId: zeta!.id,
        tenantId: a.id,
        contentType: 'image/jpeg',
        image: jpg,
      }),
    );
    expect((await app.withTenant(a.id, (tx) => store.logo(tx, zeta!.id)))!.contentType).toBe(
      'image/jpeg',
    );
    expect(await app.withTenant(b.id, (tx) => store.logo(tx, zeta!.id))).toBeNull();
    await app.withTenant(a.id, (tx) => store.removeLogo(tx, zeta!.id));
    expect(await app.withTenant(a.id, (tx) => store.logo(tx, zeta!.id))).toBeNull();
    expect(
      (await app.withTenant(a.id, (tx) => store.get(tx, zeta!.id)))!.logo_updated_at,
    ).toBeNull();
  });
});
