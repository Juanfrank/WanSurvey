import { toCsv } from '@wansurvey/fixtures';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CasesService } from '../../src/cases/cases.service.js';
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

const DAY = 86_400_000;

/** A person is not eligible when they answered recently, here or in another project. */
describe.skipIf(!configured)('SQL Server: cross-case eligibility checks', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let earlier: string;
  let project: string;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    earlier = await createProject(t.owner, tenant.id);
    project = await createProject(t.owner, tenant.id);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    // Someone (document 12345678) completed a survey of the earlier project 10 days ago; their
    // document is personal data there, so only its keyed hash can be compared.
    const pii = t.app.get(CasesService).pii;
    const sealed = pii.seal({ documento: '12345678', region: 1 }, new Set(['documento']));
    const id = randomUUID();
    const old = new Date(Date.now() - 10 * DAY).toISOString();
    await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, sample_pii, sample_pii_index, status, disposition, updated_at)
      VALUES (${id}, ${tenant.id}, ${earlier}, 'OLD-1', ${JSON.stringify(sealed.sample)}, ${sealed.samplePii},
              ${JSON.stringify(sealed.samplePiiIndex)}, 'finalised', 'COMPLETE', CAST(${old} AS datetimeoffset(3)))`.execute(
      t.owner,
    );
    await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value) VALUES (${randomUUID()}, ${tenant.id}, ${id}, 'phone', '+51987650001')`.execute(
      t.owner,
    );
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  const base = () => `/api/v1/projects/${project}`;
  const table = [
    ['id', 'documento', 'telefono', 'region'],
    ['N1', '12345678', '987650001', '1'],
    ['N2', '87654321', '987650002', '2'],
    ['N3', '11112222', '987650001', '3'],
  ];
  async function upload(target: 'cases' | 'frame') {
    const req = pm.agent
      .post(`${base()}/imports`)
      .set('x-csrf-token', pm.csrf)
      .attach('file', Buffer.from(toCsv(table)), 'people.csv');
    const up = await (target === 'frame' ? req.field('target', 'frame') : req);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const mapping = {
      ...up.body.suggested,
      defaultCountryCode: '51',
      columns: up.body.suggested.columns.map((c: { kind: string; field?: string }) =>
        c.field === 'documento' ? { ...c, kind: 'sample', type: 'text', pii: true } : c,
      ),
    };
    const report = await pm.agent
      .put(`${base()}/imports/${up.body.id}/mapping`)
      .set('x-csrf-token', pm.csrf)
      .send(mapping);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    return { id: up.body.id as string, report: report.body };
  }
  const setChecks = (crossChecks: object[], extra: object = {}) =>
    pm.agent
      .put(`${base()}/sampling`)
      .set('x-csrf-token', pm.csrf)
      .send({ crossChecks, ...extra })
      .expect(200);
  const issue = (report: { issues: { code: string; count: number }[] }) =>
    report.issues.find((i) => i.code === 'cross_check')?.count ?? 0;

  it('marks people who answered recently, here or in any project, and does not make their cases', async () => {
    // Only this project: the earlier survey does not count.
    await setChecks([{ fields: ['documento'], scope: 'project', withinDays: 30 }]);
    expect(issue((await upload('cases')).report)).toBe(0);
    // The whole organisation, but a window shorter than 10 days: not either.
    await setChecks([{ fields: ['documento'], scope: 'organisation', withinDays: 5 }]);
    expect(issue((await upload('cases')).report)).toBe(0);
    // The whole organisation, 30 days: the person with document 12345678 is out.
    await setChecks([{ fields: ['documento'], scope: 'organisation', withinDays: 30 }]);
    const { id, report } = await upload('cases');
    expect(issue(report)).toBe(1);
    expect(report.toCreate).toBe(2);
    const done = await pm.agent
      .post(`${base()}/imports/${id}/commit`)
      .set('x-csrf-token', pm.csrf)
      .send({});
    expect(done.body).toMatchObject({ created: 2, crossChecked: 1 });
    const made = await rows(
      sql`SELECT external_id FROM cases WHERE project_id = ${project} ORDER BY external_id`,
    );
    expect(made.map((c) => c.external_id)).toEqual(['N2', 'N3']);
  });

  it('a phone and a document together: both must match; the frame leaves such units out', async () => {
    const other = await createProject(t.owner, tenant.id);
    project = other;
    await setChecks([{ fields: ['documento', 'phone'], scope: 'organisation', withinDays: 30 }], {
      source: { kind: 'frame' },
      design: { family: 'census', method: 'census' },
    });
    const { id, report } = await upload('frame');
    // N1 has both; N3 shares only the phone.
    expect(issue(report)).toBe(1);
    await pm.agent
      .post(`${base()}/imports/${id}/commit`)
      .set('x-csrf-token', pm.csrf)
      .send({})
      .expect(200);
    const view = await pm.agent.get(`${base()}/sampling`).expect(200);
    expect(view.body.frame.crossChecked).toBe(1);
    const selected = await pm.agent
      .post(`${base()}/sampling/select`)
      .set('x-csrf-token', pm.csrf)
      .send({});
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    const units = await rows(
      sql`SELECT external_id, exclusion, case_id FROM frame_units WHERE project_id = ${other} ORDER BY external_id`,
    );
    expect(units.map((u) => [u.external_id, u.exclusion, !!u.case_id])).toEqual([
      ['N1', 'cross_check', false],
      ['N2', null, true],
      ['N3', null, true],
    ]);
  });
});
