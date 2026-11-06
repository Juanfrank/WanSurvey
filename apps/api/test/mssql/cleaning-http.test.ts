import { toCsv } from '@wansurvey/fixtures';
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

/** Cleaning a list as it is loaded: text tidied, saved rules, repeats, counted in the report. */
describe.skipIf(!configured)('SQL Server: cleaning a list at load', () => {
  let t: MssqlTestApp;
  let pm: Session;
  let project: string;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    const tenant = await createTenant(t.owner);
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

  const settings = (cleaning: object) =>
    pm.agent.patch(base).set('x-csrf-token', pm.csrf).send({ settings: { cleaning } });
  const table = [
    ['id', 'name', 'age', 'job'],
    ['1', 'Ana   Pérez ', '30', 'Docente'],
    ['2', 'ANA PEREZ', '31', 'Docente'],
    ['3', 'Luis Gómez', '17', 'Docente'],
    ['4', 'Eva Díaz', '45', 'Gerente general'],
    ['5', 'Mario Ríos', '50', 'Contador'],
    ['6', 'Lucía​ Paz', '52', 'Cajera'],
  ];
  async function load() {
    const up = await pm.agent
      .post(`${base}/imports`)
      .set('x-csrf-token', pm.csrf)
      .attach('file', Buffer.from(toCsv(table)), 'lista.csv');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const mapped = await pm.agent
      .put(`${base}/imports/${up.body.id}/mapping`)
      .set('x-csrf-token', pm.csrf)
      // Names would be taken as personal and sealed; the test reads them back as they are kept.
      .send({
        ...up.body.suggested,
        columns: up.body.suggested.columns.map((c: { kind: string }) =>
          c.kind === 'sample' ? { ...c, pii: false } : c,
        ),
      });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    return { id: up.body.id as string, report: mapped.body };
  }

  it('refuses a rule that does not parse or has a bad pattern', async () => {
    const bad = await settings({
      rules: [{ id: 'x', name: 'Mala', expression: 'matches(case.job, "(")' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('CLEANING_RULE_INVALID');
    expect(bad.body.message).toMatch(/Mala: matches\(\)/);
    const outside = await settings({
      rules: [{ id: 'y', name: 'Fuera', expression: 'Q1 == 1' }],
    });
    expect(outside.status).toBe(400);
  });

  it('leaves out by rule, finds the repeats, tidies the text, and counts it in the report', async () => {
    const saved = await settings({
      rules: [
        {
          id: 'direccion',
          name: 'Cargos de dirección',
          expression: 'matches(case.job, "^(ceo|gerente)")',
        },
        { id: 'menores', name: 'Menores de edad', expression: 'case.age < 18' },
        { id: 'apagada', name: 'Apagada', expression: 'case.age > 0', enabled: false },
      ],
      duplicateFields: ['name'],
      duplicateAction: 'warn',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    // Repeats are reported, and still loaded, while the project only warns.
    const first = await load();
    expect(first.report.cleaning).toEqual({
      rules: [
        { id: 'direccion', name: 'Cargos de dirección', count: 1 },
        { id: 'menores', name: 'Menores de edad', count: 1 },
      ],
      duplicates: { count: 1, excluded: 0, action: 'warn' },
    });
    expect(first.report).toMatchObject({ total: 6, valid: 6, toCreate: 4 });
    const codes = first.report.issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['excluded_rule', 'duplicate_key']));
    const dup = first.report.issues.find((i: { code: string }) => i.code === 'duplicate_key');
    expect(dup.examples[0]).toMatchObject({ row: 2, column: '#1' });

    // Excluding the repeats takes the second Ana out too.
    await settings({
      rules: [
        {
          id: 'direccion',
          name: 'Cargos de dirección',
          expression: 'matches(case.job, "^(ceo|gerente)")',
        },
        { id: 'menores', name: 'Menores de edad', expression: 'case.age < 18' },
      ],
      duplicateFields: ['name'],
      duplicateAction: 'exclude',
    });
    const second = await load();
    expect(second.report).toMatchObject({ toCreate: 3 });
    expect(second.report.cleaning.duplicates).toEqual({ count: 1, excluded: 1, action: 'exclude' });
    const done = await pm.agent
      .post(`${base}/imports/${second.id}/commit`)
      .set('x-csrf-token', pm.csrf)
      .send({});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ created: 3, excluded: 3 });

    const cases = (
      (await sql`SELECT external_id, sample FROM cases WHERE project_id = ${project} ORDER BY external_id`.execute(
        t.owner,
      )) as { rows: { external_id: string; sample: string }[] }
    ).rows;
    expect(cases.map((c) => c.external_id)).toEqual(['1', '5', '6']);
    // The text is tidied: spaces collapsed, invisible characters gone.
    expect(JSON.parse(cases[0]!.sample).name).toBe('Ana Pérez');
    expect(JSON.parse(cases[2]!.sample).name).toBe('Lucía Paz');
  });

  it('withdraws several cases at once with one reason, and skips those being worked', async () => {
    const ids = (
      (await sql`SELECT id, external_id FROM cases WHERE project_id = ${project} ORDER BY external_id`.execute(
        t.owner,
      )) as { rows: { id: string; external_id: string }[] }
    ).rows.map((r) => r.id.toLowerCase());
    expect(ids).toHaveLength(3);
    // One of them is already finished: it is not withdrawn.
    await sql`UPDATE cases SET status = 'finalised', disposition = 'COMPLETE' WHERE id = ${ids[2]}`.execute(
      t.owner,
    );
    const post = (body: object) =>
      pm.agent.post(`${base}/cases/withdraw`).set('x-csrf-token', pm.csrf).send(body);
    expect((await post({ caseIds: ids, reason: 'x' })).status).toBe(400);
    const done = await post({ caseIds: ids, reason: 'Lista antigua, ya no corresponde' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ withdrawn: 2, skipped: 1 });
    const status = (
      (await sql`SELECT status FROM cases WHERE project_id = ${project} ORDER BY external_id`.execute(
        t.owner,
      )) as { rows: { status: string }[] }
    ).rows.map((r) => r.status);
    expect(status).toEqual(['withdrawn', 'withdrawn', 'finalised']);
    const ev = (
      (await sql`SELECT details FROM case_events WHERE case_id = ${ids[0]} AND type = 'withdrawn'`.execute(
        t.owner,
      )) as { rows: { details: string }[] }
    ).rows[0]!;
    expect(JSON.parse(ev.details)).toMatchObject({
      reason: 'Lista antigua, ya no corresponde',
      bulk: 3,
    });
    // Someone who may not edit cases cannot.
    const viewer = await login(
      t,
      await createUser(
        t.owner,
        (
          (await sql`SELECT tenant_id FROM projects WHERE id = ${project}`.execute(t.owner)) as {
            rows: { tenant_id: string }[];
          }
        ).rows[0]!.tenant_id,
        [{ role: 'interviewer', projectId: project }],
      ),
      (
        (await sql`SELECT slug FROM tenants WHERE id = (SELECT tenant_id FROM projects WHERE id = ${project})`.execute(
          t.owner,
        )) as { rows: { slug: string }[] }
      ).rows[0]!.slug,
    );
    expect(
      (
        await viewer.agent
          .post(`${base}/cases/withdraw`)
          .set('x-csrf-token', viewer.csrf)
          .send({ caseIds: ids, reason: 'no puedo' })
      ).status,
    ).toBe(403);
  });
});
