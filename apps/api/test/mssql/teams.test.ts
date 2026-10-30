import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { TeamsStore } from '../../src/teams/teams-store.mssql.js';

/**
 * Teams on SQL Server (mssql/0010): a leader who is also a member, people of the organisation
 * only, a name once per organisation, members that go with their team, isolation by organisation
 * and the teams in the analysis model's people. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: teams', () => {
  let app: MssqlDatabase;
  const store = new TeamsStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `ta-${stamp}` };
  const b = { id: randomUUID(), slug: `tb-${stamp}` };
  const [ana, luis, eva, outsider] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  const owner = async <T>(
    fn: (db: ReturnType<typeof createMssqlDb<Record<string, never>>>) => Promise<T>,
  ) => {
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1, requestTimeoutMs: 0 });
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
      for (const x of [a, b])
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${x.id}, ${x.slug}, ${x.slug})`.execute(
          db,
        );
      for (const [i, [id, tenant, name]] of [
        [ana, a.id, 'Ana'],
        [luis, a.id, 'Luis'],
        [eva, a.id, 'Eva'],
        [outsider, b.id, 'Otra'],
      ].entries()) {
        await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${`t${i}-${stamp}@example.org`}, ${name})`.execute(
          db,
        );
        await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${randomUUID()}, ${tenant}, ${id}, 'active')`.execute(
          db,
        );
        await sql`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (${randomUUID()}, ${tenant}, ${id}, 'interviewer')`.execute(
          db,
        );
      }
    });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  it('creates a team whose leader is also a member, and lists it with its people', async () => {
    const id = await app.withTenant(a.id, (tx) =>
      store.create(tx, { tenantId: a.id, name: 'Norte', leaderId: ana, memberIds: [luis] }),
    );
    const teams = await app.withTenant(a.id, (tx) => store.list(tx));
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ id, name: 'Norte', leaderId: ana, leaderName: 'Ana' });
    expect(teams[0]!.members.map((m) => m.name)).toEqual(['Ana', 'Luis']);
  });

  it('keeps a name once per organisation and tells people of the organisation from strangers', async () => {
    expect(await app.withTenant(a.id, (tx) => store.nameTaken(tx, 'Norte'))).toBe(true);
    expect(await app.withTenant(a.id, (tx) => store.nameTaken(tx, 'Sur'))).toBe(false);
    await expect(
      app.withTenant(a.id, (tx) =>
        store.create(tx, { tenantId: a.id, name: 'Norte', leaderId: null, memberIds: [] }),
      ),
    ).rejects.toSatisfy(dup);
    expect(await app.withTenant(a.id, (tx) => store.strangers(tx, [ana, outsider]))).toEqual([
      outsider,
    ]);
  });

  it('changes name, leader and members; a new leader joins the team', async () => {
    const [team] = await app.withTenant(a.id, (tx) => store.list(tx));
    expect(
      await app.withTenant(a.id, (tx) =>
        store.update(tx, a.id, team!.id, { name: 'Norte 2', leaderId: eva }),
      ),
    ).toBe(true);
    const [after] = await app.withTenant(a.id, (tx) => store.list(tx));
    expect(after).toMatchObject({ name: 'Norte 2', leaderId: eva, leaderName: 'Eva' });
    expect(after!.members.map((m) => m.name)).toEqual(['Ana', 'Eva', 'Luis']);
    await app.withTenant(a.id, (tx) => store.update(tx, a.id, team!.id, { memberIds: [luis] }));
    const [only] = await app.withTenant(a.id, (tx) => store.list(tx));
    expect(only!.members.map((m) => m.name)).toEqual(['Eva', 'Luis']);
    expect(await app.withTenant(a.id, (tx) => store.update(tx, a.id, randomUUID(), {}))).toBe(
      false,
    );
  });

  it('gives the analysis model each person’s teams, only those of their organisation', async () => {
    await app.withTenant(b.id, (tx) =>
      store.create(tx, { tenantId: b.id, name: 'Otro', leaderId: outsider, memberIds: [] }),
    );
    const rows = await owner(
      async (db) =>
        (
          await sql<{ persona: string; equipos: string | null }>`
            SELECT persona, equipos FROM bi.dim_persona WHERE persona_id IN (${ana}, ${luis}, ${eva}, ${outsider})
            ORDER BY persona`.execute(db)
        ).rows,
    );
    expect(rows).toEqual([
      { persona: 'Ana', equipos: null },
      { persona: 'Eva', equipos: 'Norte 2' },
      { persona: 'Luis', equipos: 'Norte 2' },
      { persona: 'Otra', equipos: 'Otro' },
    ]);
  });

  it('is invisible to another organisation, and deleting a team deletes its members', async () => {
    expect(await app.withTenant(b.id, (tx) => store.list(tx))).toHaveLength(1);
    const [team] = await app.withTenant(a.id, (tx) => store.list(tx));
    expect(await app.withTenant(b.id, (tx) => store.remove(tx, team!.id))).toBeNull();
    expect(await app.withTenant(a.id, (tx) => store.remove(tx, team!.id))).toBe('Norte 2');
    expect(await app.withTenant(a.id, (tx) => store.list(tx))).toEqual([]);
    const left = await owner(
      async (db) =>
        (
          await sql<{
            n: number;
          }>`SELECT COUNT(*) AS n FROM team_members WHERE team_id = ${team!.id}`.execute(db)
        ).rows[0]!.n,
    );
    expect(left).toBe(0);
  });
});
