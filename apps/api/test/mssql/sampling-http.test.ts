import { sampleTable, toCsv } from '@wansurvey/fixtures';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/** The sampling selector over HTTP on SQL Server (test/sampling.test.ts). */
describe.skipIf(!configured)('SQL Server: sampling selector over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    base = `/api/v1/projects/${project}`;
  });
  afterAll(async () => {
    await t?.close();
  });
  const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    ((await query.execute(t.owner)) as { rows: T[] }).rows;
  const lower = (x: string) => x.toLowerCase();

  const post = (path: string, body: object = {}) =>
    pm.agent.post(path).set('x-csrf-token', pm.csrf).send(body);
  const put = (path: string, body: object) =>
    pm.agent.put(path).set('x-csrf-token', pm.csrf).send(body);

  async function loadFrame(n: number) {
    const up = await pm.agent
      .post(`${base}/imports`)
      .set('x-csrf-token', pm.csrf)
      .field('target', 'frame')
      .field('sourceLabel', 'Padrón 2026')
      .attach('file', Buffer.from(toCsv(sampleTable(n))), 'frame.csv');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    await put(`${base}/imports/${up.body.id}/mapping`, up.body.suggested).expect(200);
    const done = await post(`${base}/imports/${up.body.id}/commit`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return done.body;
  }

  it('selects a stratified sample from the frame, keeps π and weights, releases reserves and substitutes by rule', async () => {
    // Layer 1: a frame of 90 households; nothing becomes a case yet.
    expect(await loadFrame(90)).toMatchObject({ created: 90, frame: true });
    const before0 = await q<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM cases WHERE project_id = ${project}`,
    );
    expect(Number(before0[0]!.n)).toBe(0);

    // Layers 2 and 3: stratified by region, 12 completes, 50% response, 50% reserves.
    const plan = {
      source: { kind: 'frame', unit: 'hogares', populationKnown: true, populationSize: 90 },
      design: {
        family: 'probability',
        method: 'stratified',
        strataVar: 'region',
        allocation: 'proportional',
        within: 'srs',
      },
      size: { objective: 'fixed', fixedN: 12, response: 0.5, reserve: 0.5 },
      eligibility: 'case.age >= 25',
      substitution: { allowed: true, rule: 'sameStratum', reasons: ['REFUSAL'] },
    };
    await put(`${base}/sampling`, { ...plan, eligibility: 'nope ==' }).expect(400);
    await put(`${base}/sampling`, plan).expect(200);
    const view = await pm.agent.get(`${base}/sampling`).expect(200);
    expect(view.body.sizes).toMatchObject({ required: 12, selected: 24, reserves: 12, cases: 36 });
    expect(view.body.frame).toMatchObject({ units: 90, strata: 3 });
    expect(view.body.frame.eligible).toBeLessThan(90);
    expect(view.body.frame.sources).toEqual([{ label: 'Padrón 2026', units: 90 }]);
    expect(view.body.checks.map((c: { code: string }) => c.code)).toContain('coverage_loss');

    const preview = await post(`${base}/sampling/preview`).expect(200);
    expect(preview.body.selected).toBe(24);
    expect(preview.body.strata).toHaveLength(3);

    const selected = await post(`${base}/sampling/select`).expect(200);
    expect(selected.body.created).toBe(24);
    expect((await post(`${base}/sampling/select`)).status).toBe(409);
    const rows = await q<{
      selection_role: string;
      inclusion_prob: number;
      base_weight: number;
      region: string;
    }>(
      sql`SELECT selection_role, inclusion_prob, base_weight, JSON_VALUE(sample, '$.region') AS region
          FROM cases WHERE project_id = ${project}`,
    );
    expect(rows).toHaveLength(24);
    for (const r of rows) {
      expect(r.selection_role).toBe('main');
      expect(r.inclusion_prob).toBeGreaterThan(0);
      expect(r.base_weight).toBeCloseTo(1 / r.inclusion_prob);
    }
    // Once selected, the frame only grows: new units wait for a later batch, none is a case yet.
    const lateTable = sampleTable(3).map((r, i) => (i ? [`L${r[0]}`, ...r.slice(1)] : r));
    const late = await pm.agent
      .post(`${base}/imports`)
      .set('x-csrf-token', pm.csrf)
      .field('target', 'frame')
      .attach('file', Buffer.from(toCsv(lateTable)), 'late.csv');
    await put(`${base}/imports/${late.body.id}/mapping`, late.body.suggested);
    const grown = await post(`${base}/imports/${late.body.id}/commit`);
    expect(grown.status, JSON.stringify(grown.body)).toBe(200);
    expect(grown.body).toMatchObject({ created: 3, frame: true });
    expect(grown.body.added).toBeUndefined();

    // Reserves are released by decision, in order, and probabilities follow.
    const region1 = rows.filter((r) => r.region === '1');
    const before = region1[0]!.inclusion_prob;
    const released = await post(`${base}/sampling/release`, {
      count: 2,
      stratum: '1',
      reason: 'Baja respuesta en la región 1',
    }).expect(200);
    expect(released.body.released).toBe(2);
    const [after] = await q<{ p: number }>(
      sql`SELECT MAX(inclusion_prob) AS p FROM cases
          WHERE project_id = ${project} AND JSON_VALUE(sample, '$.region') = '1'`,
    );
    expect(after!.p).toBeGreaterThan(before);

    // A refusal can be substituted from the same stratum; the original keeps its result.
    const [refusedRow] = await q<{ id: string }>(
      sql`UPDATE cases SET status = 'finalised', disposition = 'REFUSAL'
          OUTPUT inserted.id
          WHERE id = (SELECT TOP 1 id FROM cases WHERE project_id = ${project}
                      AND selection_role = 'main' AND JSON_VALUE(sample, '$.region') = '2')`,
    );
    const refused = { id: lower(refusedRow!.id) };
    const sub = await post(`${base}/sampling/cases/${refused.id}/substitute`, {
      reason: 'Rechazo al primer contacto',
    }).expect(200);
    const [subCase] = await q<{ selection_role: string; substitute_for: string; region: string }>(
      sql`SELECT selection_role, substitute_for, JSON_VALUE(sample, '$.region') AS region
          FROM cases WHERE id = ${sub.body.substitute}`,
    );
    expect(subCase).toMatchObject({ selection_role: 'substitute', region: '2' });
    expect(lower(subCase!.substitute_for)).toBe(refused.id);
    const [orig] = await q<{ disposition: string }>(
      sql`SELECT disposition FROM cases WHERE id = ${refused.id}`,
    );
    expect(orig!.disposition).toBe('REFUSAL');
    expect(
      (await post(`${base}/sampling/cases/${refused.id}/substitute`, { reason: 'x' })).status,
    ).toBe(409);
    const events = await q<{ type: string }>(
      sql`SELECT type FROM case_events WHERE case_id = ${refused.id}`,
    );
    expect(events.map((e) => e.type)).toContain('substituted');

    // Another batch is added next to the cases already there; nothing is replaced.
    const [count0] = await q<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM cases WHERE project_id = ${project}`,
    );
    const before1 = Number(count0!.n);
    const ids0 = await q<{ id: string }>(sql`SELECT id FROM cases WHERE project_id = ${project}`);
    expect((await post(`${base}/sampling/batch`, { count: 6 })).status).toBe(400);
    const batch = await post(`${base}/sampling/batch`, {
      count: 6,
      reason: 'Más casos para cerrar el campo',
    });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    expect(batch.body).toMatchObject({ added: 6, batch: 2 });
    const all = await q<{ id: string; region: string; inclusion_prob: number }>(
      sql`SELECT id, JSON_VALUE(sample, '$.region') AS region, inclusion_prob
          FROM cases WHERE project_id = ${project}`,
    );
    expect(all).toHaveLength(before1 + 6);
    expect(ids0.every((c) => all.some((a) => a.id === c.id))).toBe(true);
    // Within a stratum every case has the same, updated probability.
    for (const region of ['1', '2', '3']) {
      const ps = new Set(all.filter((c) => c.region === region).map((c) => c.inclusion_prob));
      expect(ps.size).toBeLessThanOrEqual(1);
    }
    const plan2 = await pm.agent.get(`${base}/sampling`).expect(200);
    expect(plan2.body.result.batches).toHaveLength(1);
    const [audit] = await q<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sampling.batch_added'`,
    );
    expect(Number(audit!.n)).toBeGreaterThan(0);
  });

  it('reweighs the units without a stratum value as a stratum of their own', async () => {
    const other = await createProject(t.owner, tenant.id);
    const at = `/api/v1/projects/${other}`;
    const table = sampleTable(30).map((r, i) =>
      i && i % 5 === 0 ? [...r.slice(0, 3), '', ...r.slice(4)] : r,
    );
    const up = await pm.agent
      .post(`${at}/imports`)
      .set('x-csrf-token', pm.csrf)
      .field('target', 'frame')
      .attach('file', Buffer.from(toCsv(table)), 'frame.csv');
    await put(`${at}/imports/${up.body.id}/mapping`, up.body.suggested).expect(200);
    await post(`${at}/imports/${up.body.id}/commit`).expect(200);
    await put(`${at}/sampling`, {
      source: { kind: 'frame', unit: 'hogares', populationKnown: true, populationSize: 30 },
      design: {
        family: 'probability',
        method: 'stratified',
        strataVar: 'region',
        allocation: 'proportional',
        within: 'srs',
      },
      size: { objective: 'fixed', fixedN: 6, response: 0.5, reserve: 1 },
    }).expect(200);
    await post(`${at}/sampling/select`).expect(200);
    // Every reserve of the named strata, then what is left: those without a region.
    for (const stratum of ['1', '2', '3'])
      await post(`${at}/sampling/release`, { count: 100, stratum, reason: 'Cerrar campo' }).expect(
        200,
      );
    const prob = async () =>
      (
        await q<{ region: string | null; p: number; n: number }>(
          sql`SELECT NULLIF(JSON_VALUE(sample, '$.region'), '') AS region, MAX(inclusion_prob) AS p,
                COUNT(*) AS n FROM cases WHERE project_id = ${other}
              GROUP BY NULLIF(JSON_VALUE(sample, '$.region'), '')
              ORDER BY NULLIF(JSON_VALUE(sample, '$.region'), '')`,
        )
      ).map((r) => ({ ...r, n: Number(r.n) }));
    const before = await prob();
    const last = await post(`${at}/sampling/release`, { count: 100, reason: 'Sin región' });
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    expect(last.body.released).toBeGreaterThan(0);
    const after = await prob();
    // The regions keep theirs; the units without one get (cases / units) of their own.
    expect(after.filter((r) => r.region)).toEqual(before.filter((r) => r.region));
    const blank = after.find((r) => r.region === null)!;
    expect(blank.p).toBeCloseTo(blank.n / 6);
  });

  it('non-probability and field designs: no π, field cases on demand', async () => {
    const other = await createProject(t.owner, tenant.id);
    const b = `/api/v1/projects/${other}`;
    await put(`${b}/sampling`, {
      source: { kind: 'field', frameAvailable: false },
      design: { family: 'special', method: 'timelocation' },
      quotas: [{ name: 'Mujeres', when: 'case.sex == 2', target: 50 }],
    }).expect(200);
    const view = await pm.agent.get(`${b}/sampling`).expect(200);
    const codes = view.body.checks.map((c: { code: string }) => c.code);
    expect(codes).toContain('no_margin_of_error');
    expect(codes).toContain('quotas_as_selection');
    const made = await post(`${b}/sampling/field-cases`, {
      count: 5,
      prefix: 'MALL',
      cell: 'Centro comercial · sábado 10–12',
    }).expect(200);
    expect(made.body.created).toBe(5);
    const rows = await q<{
      external_id: string;
      selection_role: string;
      inclusion_prob: number | null;
    }>(
      sql`SELECT external_id, selection_role, inclusion_prob FROM cases
          WHERE project_id = ${other} ORDER BY external_id`,
    );
    expect(rows.map((r) => r.external_id)).toEqual([
      'MALL-0001',
      'MALL-0002',
      'MALL-0003',
      'MALL-0004',
      'MALL-0005',
    ]);
    expect(rows.every((r) => r.selection_role === 'field' && r.inclusion_prob === null)).toBe(true);

    // A probability design needs a frame.
    await put(`${b}/sampling`, {
      source: { kind: 'field', frameAvailable: false },
      design: { family: 'probability', method: 'srs' },
    }).expect(200);
    const refused = await post(`${b}/sampling/select`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PLAN_NOT_READY');
  });

  it('a census takes every eligible unit, and later units become cases at once', async () => {
    const census = await createProject(t.owner, tenant.id);
    const b = `/api/v1/projects/${census}`;
    const frame = async (rows: string[][], name: string) => {
      const up = await pm.agent
        .post(`${b}/imports`)
        .set('x-csrf-token', pm.csrf)
        .field('target', 'frame')
        .attach('file', Buffer.from(toCsv(rows)), name);
      await put(`${b}/imports/${up.body.id}/mapping`, up.body.suggested).expect(200);
      return (await post(`${b}/imports/${up.body.id}/commit`).expect(200)).body;
    };
    const table = sampleTable(10);
    await frame(table, 'census.csv');
    await put(`${b}/sampling`, {
      source: { kind: 'frame' },
      design: { family: 'census', method: 'census' },
      size: { objective: 'fixed', fixedN: 10 },
    }).expect(200);
    expect((await post(`${b}/sampling/select`).expect(200)).body.created).toBe(10);
    const late = [table[0]!, ...sampleTable(13).slice(12)].map((r, i) =>
      i === 0 ? r : [`L${r[0]}`, ...r.slice(1)],
    );
    expect(await frame(late, 'late.csv')).toMatchObject({ created: 2, added: 2 });
    const rows = await q<{ selection_role: string; inclusion_prob: number }>(
      sql`SELECT selection_role, inclusion_prob FROM cases WHERE project_id = ${census}`,
    );
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.selection_role === 'main' && r.inclusion_prob === 1)).toBe(true);
  });
});
