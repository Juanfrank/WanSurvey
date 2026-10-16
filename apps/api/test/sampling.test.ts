import { sampleTable, toCsv } from '@wansurvey/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
} from './harness.js';

describe('sampling selector', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    base = `/api/v1/projects/${project}`;
  });
  afterAll(() => t.close());

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
    const before0 = await t.admin<{ n: number }[]>`
      select count(*)::int as n from cases where project_id = ${project}`;
    expect(before0[0]!.n).toBe(0);

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
    const rows = await t.admin<
      { selection_role: string; inclusion_prob: number; base_weight: number; region: string }[]
    >`select selection_role, inclusion_prob, base_weight, sample->>'region' as region
      from cases where project_id = ${project}`;
    expect(rows).toHaveLength(24);
    for (const r of rows) {
      expect(r.selection_role).toBe('main');
      expect(r.inclusion_prob).toBeGreaterThan(0);
      expect(r.base_weight).toBeCloseTo(1 / r.inclusion_prob);
    }
    // The frame cannot change once selected.
    const late = await pm.agent
      .post(`${base}/imports`)
      .set('x-csrf-token', pm.csrf)
      .field('target', 'frame')
      .attach('file', Buffer.from(toCsv(sampleTable(3))), 'late.csv');
    await put(`${base}/imports/${late.body.id}/mapping`, late.body.suggested);
    expect((await post(`${base}/imports/${late.body.id}/commit`)).body.code).toBe(
      'SAMPLE_SELECTED',
    );

    // Reserves are released by decision, in order, and probabilities follow.
    const region1 = rows.filter((r) => r.region === '1');
    const before = region1[0]!.inclusion_prob;
    const released = await post(`${base}/sampling/release`, {
      count: 2,
      stratum: '1',
      reason: 'Baja respuesta en la región 1',
    }).expect(200);
    expect(released.body.released).toBe(2);
    const [after] = await t.admin<{ p: number }[]>`
      select max(inclusion_prob) as p from cases
      where project_id = ${project} and sample->>'region' = '1'`;
    expect(after!.p).toBeGreaterThan(before);

    // A refusal can be substituted from the same stratum; the original keeps its result.
    const [refused] = await t.admin<{ id: string }[]>`
      update cases set status = 'finalised', disposition = 'REFUSAL'
      where id = (select id from cases where project_id = ${project} and selection_role = 'main'
                  and sample->>'region' = '2' limit 1)
      returning id`;
    const sub = await post(`${base}/sampling/cases/${refused!.id}/substitute`, {
      reason: 'Rechazo al primer contacto',
    }).expect(200);
    const [subCase] = await t.admin<
      { selection_role: string; substitute_for: string; region: string }[]
    >`
      select selection_role, substitute_for, sample->>'region' as region from cases where id = ${sub.body.substitute}`;
    expect(subCase).toMatchObject({
      selection_role: 'substitute',
      substitute_for: refused!.id,
      region: '2',
    });
    const [orig] = await t.admin<{ disposition: string }[]>`
      select disposition from cases where id = ${refused!.id}`;
    expect(orig!.disposition).toBe('REFUSAL');
    expect(
      (await post(`${base}/sampling/cases/${refused!.id}/substitute`, { reason: 'x' })).status,
    ).toBe(409);
    const events = await t.admin<{ type: string }[]>`
      select type from case_events where case_id = ${refused!.id}`;
    expect(events.map((e) => e.type)).toContain('substituted');
  });

  it('non-probability and field designs: no π, field cases on demand', async () => {
    const other = await createProject(t.admin, tenant.id);
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
    const rows = await t.admin<
      { external_id: string; selection_role: string; inclusion_prob: number | null }[]
    >`
      select external_id, selection_role, inclusion_prob from cases where project_id = ${other} order by external_id`;
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
    const census = await createProject(t.admin, tenant.id);
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
    const rows = await t.admin<{ selection_role: string; inclusion_prob: number }[]>`
      select selection_role, inclusion_prob from cases where project_id = ${census}`;
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.selection_role === 'main' && r.inclusion_prob === 1)).toBe(true);
  });
});
