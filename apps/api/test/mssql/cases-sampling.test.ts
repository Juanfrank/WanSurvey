import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CasesStore } from '../../src/cases/cases-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { SamplingStore } from '../../src/sampling/sampling-store.mssql.js';

/**
 * Cases and sampling on SQL Server (mssql/0003): bulk loads through OPENJSON, assignment and
 * claiming under concurrency, the append-only history, the sampling plan and frame, cases made
 * from selected units, reserves, goals, and isolation by organisation. Runs only where a SQL
 * Server is given (see isolation.test.ts).
 */
/** SQL Server says 2627 for a unique constraint and 2601 for a unique index. */
const isDuplicateKey = (e: unknown) =>
  [2601, 2627].includes((e as { number?: number }).number ?? 0);

const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: cases and sampling', () => {
  let app: MssqlDatabase;
  const cases = new CasesStore();
  const sampling = new SamplingStore();
  const stamp = Date.now().toString(36);
  const t = (name: string) => ({
    id: randomUUID(),
    slug: `${name}-${stamp}`,
    project: randomUUID(),
  });
  const a = t('ca');
  const b = t('cb');
  const sup = randomUUID();
  const people = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 8 });
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      for (const x of [a, b]) {
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${x.id}, ${x.slug}, ${x.slug})`.execute(
          owner,
        );
        await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${x.project}, ${x.id}, 'P', ${'P-' + x.slug})`.execute(
          owner,
        );
      }
      for (const [i, id] of [sup, ...people].entries())
        await sql`INSERT INTO users (id, tenant_id, email, name) VALUES (${id}, ${a.id}, ${`u${i}-${stamp}@example.org`}, ${`U${i}`})`.execute(
          owner,
        );
    } finally {
      await owner.destroy();
    }
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const load = (
    n: number,
    prefix: string,
    extra: Partial<Parameters<CasesStore['insertCases']>[1]['cases'][number]> = {},
  ) =>
    app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: a.project,
        cases: Array.from({ length: n }, (_, i) => ({
          externalId: `${prefix}-${i}`,
          sample: { region: i % 2 ? 'norte' : 'sur', n: i },
          priority: i % 3,
          contacts: [{ type: 'phone', value: `+5025550${String(i).padStart(4, '0')}` }],
          ...extra,
        })),
      }),
    );

  it('loads thousands of cases and their contacts in one round trip, and a repeated id fails the whole load', async () => {
    const ids = await load(3000, `big-${stamp}`);
    expect(ids).toHaveLength(3000);
    const n = await app.withTenant(a.id, (tx) =>
      tx
        .selectFrom('contacts')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('case_id', 'in', ids.slice(0, 5))
        .executeTakeFirstOrThrow(),
    );
    expect(n.n).toBe(5);
    const before =
      (await app.withTenant(a.id, (tx) => cases.countByStatus(tx, a.project))).fresh ?? 0;
    await expect(
      app.withTenant(a.id, (tx) =>
        cases.insertCases(tx, {
          tenantId: a.id,
          projectId: a.project,
          cases: [{ externalId: 'new-one' }, { externalId: `big-${stamp}-7` }],
        }),
      ),
    ).rejects.toSatisfy(isDuplicateKey);
    expect((await app.withTenant(a.id, (tx) => cases.countByStatus(tx, a.project))).fresh).toBe(
      before,
    );
  });

  it('allows one case per external id with no questionnaire, and the same id under another', async () => {
    const q1 = randomUUID();
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await sql`INSERT INTO questionnaires (id, tenant_id, project_id, name, draft) VALUES (${q1}, ${a.id}, ${a.project}, 'Q', '{}')`.execute(
        owner,
      );
    } finally {
      await owner.destroy();
    }
    const ext = `dup-${stamp}`;
    const insert = (qid: string | null) =>
      app.withTenant(a.id, (tx) =>
        cases.insertCases(tx, {
          tenantId: a.id,
          projectId: a.project,
          cases: [{ externalId: ext, questionnaireId: qid }],
        }),
      );
    await insert(null);
    await expect(insert(null)).rejects.toSatisfy(isDuplicateKey);
    await insert(q1);
    await expect(insert(q1)).rejects.toSatisfy(isDuplicateKey);
  });

  it('keeps a sample field personal once any load says so', async () => {
    const fields = (pii: boolean) =>
      app.withTenant(a.id, (tx) =>
        cases.ensureFields(tx, a.id, a.project, [{ name: 'telefono', pii }, { name: 'region' }]),
      );
    await fields(true);
    await fields(false);
    const list = await app.withTenant(a.id, (tx) => cases.fields(tx, a.project));
    const by = Object.fromEntries(list.map((f) => [f.name, f.pii]));
    expect(by).toMatchObject({ telefono: true, region: false });
    expect(list.filter((f) => f.name === 'telefono')).toHaveLength(1);
  });

  it('pages cases by priority then id without repeating or skipping, and filters', async () => {
    const prefix = `page-${stamp}`;
    await load(25, prefix);
    const seen: string[] = [];
    let after: { priority: number; id: string } | undefined;
    for (;;) {
      const page = await app.withTenant(a.id, (tx) =>
        cases.list(tx, { projectId: a.project, text: prefix }, { limit: 10, after }),
      );
      if (!page.length) break;
      seen.push(...page.map((c) => c.external_id));
      const last = page[page.length - 1]!;
      after = { priority: last.priority, id: last.id };
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    // High priority first.
    const first = await app.withTenant(a.id, (tx) =>
      cases.list(tx, { projectId: a.project, text: prefix }, { limit: 25 }),
    );
    expect(first.map((c) => c.priority)).toEqual(
      [...first.map((c) => c.priority)].sort((x, y) => y - x),
    );
    // The sample is searched as text, and % is a literal character.
    const norte = await app.withTenant(a.id, (tx) =>
      cases.list(tx, { projectId: a.project, text: '"norte"' }, { limit: 5000 }),
    );
    expect(norte.length).toBeGreaterThan(0);
    expect(
      await app.withTenant(a.id, (tx) =>
        cases.list(tx, { projectId: a.project, text: '%' }, { limit: 5 }),
      ),
    ).toEqual([]);
  });

  it('finds cases by hashed words of the personal fields, all of them', async () => {
    await app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: a.project,
        cases: [
          {
            externalId: `pii1-${stamp}`,
            samplePii: 'sealed',
            samplePiiIndex: ['h-ana', 'h-lopez'],
          },
          {
            externalId: `pii2-${stamp}`,
            samplePii: 'sealed',
            samplePiiIndex: ['h-ana', 'h-perez'],
          },
        ],
      }),
    );
    const find = (tokens: string[]) =>
      app.withTenant(a.id, (tx) =>
        cases.list(tx, { projectId: a.project, piiTokens: tokens }, { limit: 10 }),
      );
    expect((await find(['h-ana'])).map((c) => c.external_id).sort()).toEqual([
      `pii1-${stamp}`,
      `pii2-${stamp}`,
    ]);
    expect((await find(['h-ana', 'h-lopez'])).map((c) => c.external_id)).toEqual([`pii1-${stamp}`]);
    expect(await find(['h-ana', 'h-nadie'])).toEqual([]);
  });

  it('assigns, leaves cases already held alone, unassigns, and writes the history', async () => {
    const ids = (await load(6, `asg-${stamp}`)).slice(0, 4);
    const assign = (
      caseIds: string[],
      userId: string | null,
      only?: { statuses?: string[]; unassigned?: boolean },
    ) =>
      app.withTenant(a.id, (tx) =>
        cases.assign(tx, {
          tenantId: a.id,
          actorUserId: sup,
          projectId: a.project,
          caseIds,
          userId,
          via: 'manual',
          only,
        }),
      );
    expect(await assign(ids, people[0]!)).toHaveLength(4);
    expect(await assign(ids, people[0]!)).toHaveLength(0);
    const c = await app.withTenant(a.id, (tx) => cases.get(tx, a.project, ids[0]!));
    expect(c).toMatchObject({ status: 'assigned' });
    expect(c!.assigned_to?.toLowerCase()).toBe(people[0]);
    expect(c!.assigned_at).toBeInstanceOf(Date);
    // Only unassigned ones: none of these qualify.
    expect(await assign(ids, people[1]!, { unassigned: true })).toHaveLength(0);
    expect(await assign(ids.slice(0, 2), null)).toHaveLength(2);
    const back = await app.withTenant(a.id, (tx) => cases.get(tx, a.project, ids[0]!));
    expect(back).toMatchObject({ status: 'fresh', assigned_to: null, assigned_at: null });
    const events = await app.withTenant(a.id, (tx) => cases.events(tx, ids[0]!));
    expect(events.map((e) => e.type)).toEqual(['assigned', 'unassigned']);
    expect(events[0]!.details).toMatchObject({ to: people[0], via: 'manual' });
    expect(
      (await app.withTenant(a.id, (tx) => cases.heldByUser(tx, a.project))).get(people[0]!),
    ).toBe(2);
  });

  it('gives each case to one supervisor when two assign the same free cases at once', async () => {
    const ids = await load(40, `race-${stamp}`);
    const go = (userId: string) =>
      app.withTenant(a.id, (tx) =>
        cases.assign(tx, {
          tenantId: a.id,
          actorUserId: sup,
          projectId: a.project,
          caseIds: ids,
          userId,
          via: 'rule',
          only: { unassigned: true, statuses: ['fresh'] },
        }),
      );
    const [r1, r2] = await Promise.all([go(people[1]!), go(people[2]!)]);
    expect(r1.length + r2.length).toBe(40);
    const held = await app.withTenant(a.id, (tx) => cases.heldByUser(tx, a.project));
    expect((held.get(people[1]!) ?? 0) + (held.get(people[2]!) ?? 0)).toBeGreaterThanOrEqual(40);
  });

  it('lets one person claim a case when many try at once', async () => {
    const [id] = await load(1, `claim-${stamp}`);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.withTenant(a.id, (tx) =>
          cases.claim(tx, { projectId: a.project, caseId: id!, userId: people[i % 3]! }),
        ),
      ),
    );
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'taken')).toHaveLength(7);
    expect(
      await app.withTenant(a.id, (tx) =>
        cases.claim(tx, { projectId: a.project, caseId: randomUUID(), userId: people[0]! }),
      ),
    ).toBe('not_found');
  });

  it('gives simultaneous claimNext calls different cases, the highest priority first', async () => {
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    const pool = { id: randomUUID(), project: randomUUID() };
    try {
      await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${pool.project}, ${a.id}, 'Pool', ${'POOL-' + stamp})`.execute(
        owner,
      );
    } finally {
      await owner.destroy();
    }
    await app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: pool.project,
        cases: Array.from({ length: 6 }, (_, i) => ({ externalId: `p-${i}`, priority: i })),
      }),
    );
    const taken = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.withTenant(a.id, (tx) =>
          cases.claimNext(tx, { projectId: pool.project, userId: people[i % 3]! }),
        ),
      ),
    );
    expect(taken.every((x) => x !== null)).toBe(true);
    expect(new Set(taken).size).toBe(6);
    expect(
      await app.withTenant(a.id, (tx) =>
        cases.claimNext(tx, { projectId: pool.project, userId: people[0]! }),
      ),
    ).toBeNull();
    // With one free case left at a time, the best one goes first.
    const [x] = await app.withTenant(a.id, (tx) =>
      cases.list(tx, { projectId: pool.project, statuses: ['assigned'] }, { limit: 1 }),
    );
    expect(x!.priority).toBe(5);
  });

  it('keeps the case history append-only: no privilege for the application, a trigger for the owner', async () => {
    const [id] = await load(1, `hist-${stamp}`);
    await app.withTenant(a.id, (tx) =>
      cases.addEvents(tx, a.id, sup, [{ caseId: id!, type: 'note', details: { text: 'ok' } }]),
    );
    await expect(
      app.withTenant(a.id, (tx) =>
        tx.updateTable('case_events').set({ type: 'x' }).where('case_id', '=', id!).execute(),
      ),
    ).rejects.toThrow(/permission was denied/i);
    await expect(
      app.withTenant(a.id, (tx) => sql`DELETE FROM case_events WHERE case_id = ${id}`.execute(tx)),
    ).rejects.toThrow(/permission was denied/i);
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await expect(
        sql`UPDATE case_events SET type = 'x' WHERE case_id = ${id}`.execute(owner),
      ).rejects.toThrow(/append-only/);
    } finally {
      await owner.destroy();
    }
  });

  it('keeps one sampling plan per questionnaire, editable until it is selected', async () => {
    const save = (seed: string, questionnaireId: string | null = null) =>
      app.withTenant(a.id, (tx) =>
        sampling.savePlan(tx, {
          tenantId: a.id,
          projectId: a.project,
          questionnaireId,
          userId: sup,
          input: { seed, design: { family: 'census' }, quotas: [{ cell: 'x' }] },
        }),
      );
    const first = await save('s1');
    expect(await save('s2')).toBe(first);
    const plan = await app.withTenant(a.id, (tx) => sampling.plan(tx, a.project, null));
    expect(plan).toMatchObject({ seed: 's2', status: 'draft' });
    expect(JSON.parse(plan!.design)).toEqual({ family: 'census' });
    await app.withTenant(a.id, (tx) => sampling.markSelected(tx, first, { picked: 3 }, sup));
    await expect(save('s3')).rejects.toThrow(/already selected/);
    const done = await app.withTenant(a.id, (tx) => sampling.plan(tx, a.project, null));
    expect(done).toMatchObject({ status: 'selected' });
    expect(JSON.parse(done!.result!)).toEqual({ picked: 3 });
  });

  it('adds frame units skipping those already there, even when two loads race', async () => {
    const proj = randomUUID();
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${proj}, ${a.id}, 'Frame', ${'FR-' + stamp})`.execute(
        owner,
      );
    } finally {
      await owner.destroy();
    }
    const units = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({
        externalId: `u-${from + i}`,
        sample: { region: (from + i) % 2 ? 'norte' : 'sur' },
        contacts: [{ type: 'email', value: `u${from + i}@example.org` }],
      }));
    const add = (u: ReturnType<typeof units>) =>
      app.withTenant(a.id, (tx) =>
        sampling.addUnits(tx, { tenantId: a.id, projectId: proj, questionnaireId: null, units: u }),
      );
    expect(await add(units(0, 100))).toBe(100);
    expect(await add(units(50, 150))).toBe(50);
    const [r1, r2] = await Promise.all([add(units(150, 200)), add(units(150, 200))]);
    expect(r1 + r2).toBe(50);
    const counts = await app.withTenant(a.id, (tx) => sampling.unitCounts(tx, proj, null));
    expect(counts.reduce((s, c) => s + c.n, 0)).toBe(200);
  });

  it('records a selection, makes cases with contacts from the units once, and releases reserves in order', async () => {
    const proj = randomUUID();
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${proj}, ${a.id}, 'Select', ${'SE-' + stamp})`.execute(
        owner,
      );
    } finally {
      await owner.destroy();
    }
    await app.withTenant(a.id, (tx) =>
      sampling.addUnits(tx, {
        tenantId: a.id,
        projectId: proj,
        questionnaireId: null,
        units: Array.from({ length: 10 }, (_, i) => ({
          externalId: `s-${i}`,
          sample: { n: i },
          samplePii: 'sealed',
          contacts: [
            { type: 'phone', value: `+50255${i}` },
            { type: 'email', value: `s${i}@example.org` },
          ],
        })),
      }),
    );
    const units = await app.withTenant(a.id, (tx) =>
      tx
        .selectFrom('frame_units')
        .select(['id', 'external_id'])
        .where('project_id', '=', proj)
        .orderBy('external_id')
        .execute(),
    );
    const id = (n: number) => units.find((u) => u.external_id === `s-${n}`)!.id.toLowerCase();
    await app.withTenant(a.id, (tx) =>
      sampling.recordSelection(tx, [
        ...[0, 1, 2].map((n) => ({
          unitId: id(n),
          role: 'main' as const,
          prob: 0.5,
          weight: 2,
          stratum: n % 2 ? 'norte' : 'sur',
        })),
        ...[3, 4, 5].map((n, k) => ({
          unitId: id(n),
          role: 'reserve' as const,
          releaseOrder: 3 - k,
        })),
        { unitId: id(9), role: null, eligible: false, exclusion: 'duplicado' },
      ]),
    );
    const picked = await app.withTenant(a.id, (tx) =>
      tx
        .selectFrom('frame_units')
        .select([
          'external_id',
          'role',
          'inclusion_prob',
          'base_weight',
          'stratum',
          'eligible',
          'exclusion',
        ])
        .where('project_id', '=', proj)
        .where('external_id', 'in', ['s-0', 's-9'])
        .orderBy('external_id')
        .execute(),
    );
    expect(picked[0]).toMatchObject({
      role: 'main',
      inclusion_prob: 0.5,
      base_weight: 2,
      stratum: 'sur',
      eligible: true,
    });
    expect(picked[1]).toMatchObject({ role: null, eligible: false, exclusion: 'duplicado' });

    const make = () =>
      app.withTenant(a.id, (tx) =>
        sampling.makeCases(tx, {
          projectId: proj,
          questionnaireId: null,
          cases: [0, 1, 2].map((n) => ({
            unitId: id(n),
            role: 'main' as const,
            prob: 0.5,
            weight: 2,
          })),
        }),
      );
    const made = await make();
    expect(made).toHaveLength(3);
    expect(await make()).toHaveLength(0);
    const row = await app.withTenant(a.id, (tx) =>
      cases.list(tx, { projectId: proj }, { limit: 10 }),
    );
    expect(row).toHaveLength(3);
    expect(row[0]).toMatchObject({
      selection_role: 'main',
      inclusion_prob: 0.5,
      base_weight: 2,
      sample_pii: 'sealed',
    });
    const contacts = await app.withTenant(a.id, (tx) =>
      tx
        .selectFrom('contacts')
        .select(['type', 'value'])
        .where('case_id', '=', made[0]!.caseId)
        .orderBy('type')
        .execute(),
    );
    expect(contacts.map((c) => c.type)).toEqual(['email', 'phone']);
    const linked = await app.withTenant(a.id, (tx) =>
      tx
        .selectFrom('frame_units')
        .select('case_id')
        .where('id', '=', made[0]!.unitId)
        .executeTakeFirstOrThrow(),
    );
    expect(linked.case_id?.toLowerCase()).toBe(made[0]!.caseId);

    // Reserves go out in release order, and two releases at once get different units.
    const first = await app.withTenant(a.id, (tx) =>
      sampling.releaseReserves(tx, { projectId: proj, questionnaireId: null, count: 1 }),
    );
    expect(first).toEqual([id(5)]);
    const both = await Promise.all([
      app.withTenant(a.id, (tx) =>
        sampling.releaseReserves(tx, { projectId: proj, questionnaireId: null, count: 1 }),
      ),
      app.withTenant(a.id, (tx) =>
        sampling.releaseReserves(tx, { projectId: proj, questionnaireId: null, count: 1 }),
      ),
    ]);
    expect(new Set(both.flat()).size).toBe(both.flat().length);
    expect(both.flat().every((x) => [id(3), id(4)].includes(x))).toBe(true);
    // A selected plan keeps its frame.
    await app.withTenant(a.id, (tx) =>
      sampling.savePlan(tx, {
        tenantId: a.id,
        projectId: proj,
        questionnaireId: null,
        userId: sup,
        input: { seed: 'z' },
      }),
    );
    const planId = (await app.withTenant(a.id, (tx) => sampling.plan(tx, proj, null)))!.id;
    await app.withTenant(a.id, (tx) => sampling.markSelected(tx, planId, {}, sup));
    await expect(app.withTenant(a.id, (tx) => sampling.clearFrame(tx, proj, null))).rejects.toThrow(
      /already selected/,
    );
  });

  it('clears a frame that was not selected', async () => {
    const proj = randomUUID();
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${proj}, ${a.id}, 'Clear', ${'CL-' + stamp})`.execute(
        owner,
      );
    } finally {
      await owner.destroy();
    }
    await app.withTenant(a.id, (tx) =>
      sampling.addUnits(tx, {
        tenantId: a.id,
        projectId: proj,
        questionnaireId: null,
        units: [{ externalId: 'x1' }, { externalId: 'x2' }],
      }),
    );
    expect(await app.withTenant(a.id, (tx) => sampling.clearFrame(tx, proj, null))).toBe(2);
  });

  it('keeps goals with their dates as plain dates, for a person or the whole team', async () => {
    const mine = await app.withTenant(a.id, (tx) =>
      sampling.addGoal(tx, {
        tenantId: a.id,
        projectId: a.project,
        userId: people[0],
        frequency: 'weekly',
        startsOn: '2026-11-02',
        endsOn: '2026-11-30',
        target: 40,
        createdBy: sup,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      sampling.addGoal(tx, {
        tenantId: a.id,
        projectId: a.project,
        startsOn: '2026-11-01',
        endsOn: '2026-12-31',
        target: 500,
        createdBy: sup,
      }),
    );
    const goals = await app.withTenant(a.id, (tx) => sampling.goals(tx, a.project));
    expect(goals.map((g) => [g.starts_on, g.ends_on, g.target, g.user_id])).toEqual([
      ['2026-11-01', '2026-12-31', 500, null],
      ['2026-11-02', '2026-11-30', 40, people[0]!.toUpperCase()],
    ]);
    await app.withTenant(a.id, (tx) => sampling.deleteGoal(tx, mine));
    expect(await app.withTenant(a.id, (tx) => sampling.goals(tx, a.project))).toHaveLength(1);
  });

  it('shows another organisation nothing, and refuses its writes', async () => {
    expect(
      await app.withTenant(b.id, (tx) => cases.list(tx, { projectId: a.project }, { limit: 10 })),
    ).toEqual([]);
    expect(await app.withTenant(b.id, (tx) => sampling.goals(tx, a.project))).toEqual([]);
    await expect(
      app.withTenant(b.id, (tx) =>
        cases.insertCases(tx, {
          tenantId: a.id,
          projectId: a.project,
          cases: [{ externalId: 'evil' }],
        }),
      ),
    ).rejects.toThrow();
  });
});
