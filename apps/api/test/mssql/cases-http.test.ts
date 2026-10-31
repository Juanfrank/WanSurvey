import { sampleTable, toCsv } from '@wansurvey/fixtures';
import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportMapping } from '../../src/cases/sample-mapping.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
  type TestUser,
} from './harness.js';

async function xlsx(table: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sample');
  table.forEach((r, i) =>
    ws.addRow(i === 0 ? r : r.map((c) => (/^\d+$/.test(c) && c.length < 6 ? Number(c) : c))),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Importing, listing, revealing, assigning and editing cases over HTTP on SQL Server (test/cases.test.ts). */
describe.skipIf(!configured)('SQL Server: cases over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;
  let supervisor: Session;
  let clerk: Session;
  let interviewer: TestUser;
  let interviewerS: Session;
  let interviewer2: TestUser;
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
    supervisor = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor' }]),
      tenant.slug,
    );
    const clerkUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    clerk = await login(t, clerkUser, tenant.slug);
    interviewer = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    interviewerS = await login(t, interviewer, tenant.slug);
    interviewer2 = await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]);
    base = `/api/v1/projects/${project}`;
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const caseId = async (externalId: string) =>
    (
      (
        await rows(
          sql`SELECT id FROM cases WHERE project_id = ${project} AND external_id = ${externalId}`,
        )
      )[0]!.id as string
    ).toLowerCase();

  const upload = (s: Session, body: Buffer, name: string) =>
    s.agent.post(`${base}/imports`).set('x-csrf-token', s.csrf).attach('file', body, name);
  const put = (s: Session, path: string, body: object) =>
    s.agent.put(path).set('x-csrf-token', s.csrf).send(body);
  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);

  async function importTable(
    table: string[][],
    mapping: Partial<ImportMapping> = {},
    xlsxFile = false,
  ) {
    const up = xlsxFile
      ? await upload(pm, await xlsx(table), 'sample.xlsx')
      : await upload(pm, Buffer.from(toCsv(table)), 'sample.csv');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const m = { ...up.body.suggested, ...mapping };
    const report = await put(pm, `${base}/imports/${up.body.id}/mapping`, m);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    return { id: up.body.id as string, upload: up.body, report: report.body };
  }

  it('imports an XLSX: map, validate, refuse invalid rows, then commit skipping them', async () => {
    const { id, upload: up, report } = await importTable(sampleTable(30, true), {}, true);
    expect(up.headers[0]).toBe('id');
    expect(up.preview).toHaveLength(20);
    expect(report).toMatchObject({ total: 31, valid: 28, invalid: 3 });

    const refused = await post(pm, `${base}/imports/${id}/commit`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('INVALID_ROWS');

    const csv = await pm.agent.get(`${base}/imports/${id}/report.csv`);
    expect(csv.text).toContain('invalid_email');
    expect(csv.text.split('\n').filter((l) => l.includes('invalid_email'))).toHaveLength(2);

    await put(pm, `${base}/imports/${id}/mapping`, { ...up.suggested, skipInvalid: true });
    const done = await post(pm, `${base}/imports/${id}/commit`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ created: 28, updated: 0, skipped: 3 });
    expect((await post(pm, `${base}/imports/${id}/commit`)).status).toBe(409);

    const staged = await rows(
      sql`SELECT COUNT(*) AS n FROM sample_import_rows WHERE import_id = ${id}`,
    );
    expect(Number(staged[0]!.n)).toBe(0);
    const fields = await pm.agent.get(`${base}/sample-fields`);
    expect(fields.body.map((f: { name: string }) => f.name)).toContain('first_name');
    expect(fields.body.find((f: { name: string }) => f.name === 'first_name').pii).toBe(true);
  });

  it('updates existing cases on request and warns about a re-uploaded file', async () => {
    const table = sampleTable(3);
    table[1]![4] = 'Trujillo';
    const up = await upload(pm, Buffer.from(toCsv(table)), 'again.csv');
    const r = await put(pm, `${base}/imports/${up.body.id}/mapping`, {
      ...up.body.suggested,
      existing: 'update',
    });
    expect(r.body).toMatchObject({ existing: 3, toCreate: 0, toUpdate: 3 });
    const done = await post(pm, `${base}/imports/${up.body.id}/commit`);
    expect(done.body).toMatchObject({ created: 0, updated: 3 });
    const [c] = await rows(
      sql`SELECT sample FROM cases WHERE project_id = ${project} AND external_id = 'HH0001'`,
    );
    expect((JSON.parse(c!.sample as string) as { city: string }).city).toBe('Trujillo');
    const again = await upload(pm, Buffer.from(toCsv(table)), 'again.csv');
    expect(again.body.duplicateOf).toBe(up.body.id);
  });

  it('lists cases with counts, search and filters; masks personal data', async () => {
    const list = await pm.agent.get(`${base}/cases`).query({ limit: 10 });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(28);
    expect(list.body.rows).toHaveLength(10);
    expect(list.body.counts.fresh).toBe(28);
    // Even a project manager sees masked personal fields in lists.
    expect(list.body.rows[0].sample.first_name).toBe('•••');
    expect(list.body.rows[0].sample.region).toEqual(expect.any(Number));

    const region = await pm.agent.get(`${base}/cases`).query({ filter: 'case.region == 1' });
    expect(region.body.total).toBe(region.body.rows.length);
    expect(
      region.body.rows.every((r: { sample: { region: number } }) => r.sample.region === 1),
    ).toBe(true);
    const bad = await pm.agent.get(`${base}/cases`).query({ filter: 'Q1 == 1' });
    expect(bad.status).toBe(400);

    const found = await pm.agent.get(`${base}/cases`).query({ q: 'HH0003' });
    expect(found.body.rows.map((r: { externalId: string }) => r.externalId)).toEqual(['HH0003']);
  });

  it('filters by personal fields only as the viewer sees them', async () => {
    const cid = await caseId('HH0001');
    const shown = await pm.agent.get(`${base}/cases/${cid}`).query({ reveal: 'pii' });
    const name = shown.body.sample.first_name as string;
    const filter = `case.first_name == ${JSON.stringify(name)}`;
    const byPm = await pm.agent.get(`${base}/cases`).query({ filter });
    expect(byPm.body.rows.map((r: { externalId: string }) => r.externalId)).toContain('HH0001');
    // Without `pii.view`, a filter cannot test hidden values one guess at a time.
    await sql`UPDATE tenants SET role_permissions = ${JSON.stringify({
      supervisor: ROLE_PERMISSIONS.supervisor.filter((p) => p !== 'pii.view'),
    })} WHERE id = ${tenant.id}`.execute(t.owner);
    try {
      const bySup = await supervisor.agent.get(`${base}/cases`).query({ filter });
      expect(bySup.status).toBe(200);
      expect(bySup.body.total).toBe(0);
      const preview = await post(supervisor, `${base}/assignments/preview`, { filter });
      expect(preview.body.matching).toBe(0);
    } finally {
      await sql`UPDATE tenants SET role_permissions = '{}' WHERE id = ${tenant.id}`.execute(
        t.owner,
      );
    }
  });

  it('reveals personal data only on request, with an audit entry', async () => {
    const c = { id: await caseId('HH0004') };
    const masked = await pm.agent.get(`${base}/cases/${c.id}`);
    expect(masked.body.contacts[0].value).toBe('•••');
    expect(masked.body.pii).toEqual({ masked: true, canReveal: true, auto: false });
    const shown = await pm.agent.get(`${base}/cases/${c.id}`).query({ reveal: 'pii' });
    expect(shown.body.sample.first_name).toBe('Luis');
    expect(shown.body.contacts.map((x: { value: string }) => x.value)).toContain(
      'luis.4@example.org',
    );
    const audit = await rows(
      sql`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'case.pii_viewed' AND target_id = ${c.id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('assigns in bulk only to eligible people; interviewers see only their cases', async () => {
    const ids = (
      await pm.agent.get(`${base}/cases`).query({ filter: 'case.region == 2' })
    ).body.rows.map((r: { id: string }) => r.id);
    const notEligible = await post(supervisor, `${base}/cases/assign`, {
      caseIds: ids,
      userId: (await createUser(t.owner, tenant.id, [{ role: 'reviewer' }])).id,
    });
    expect(notEligible.status).toBe(400);
    expect(notEligible.body.code).toBe('NOT_AN_ASSIGNEE');

    const res = await post(supervisor, `${base}/cases/assign`, {
      caseIds: ids,
      userId: interviewer.id,
    });
    expect(res.body.changed).toBe(ids.length);
    const mine = await interviewerS.agent.get(`${base}/cases`);
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(ids.length);
    expect(mine.body.rows.every((r: { status: string }) => r.status === 'assigned')).toBe(true);
    const other = (await pm.agent.get(`${base}/cases`).query({ filter: 'case.region == 1' })).body
      .rows[0].id;
    expect((await interviewerS.agent.get(`${base}/cases/${other}`)).status).toBe(404);

    // Another interviewer has no cases and sees none.
    const none = await clerk.agent.get(`${base}/cases`);
    expect(none.body.total).toBe(0);

    const history = await pm.agent.get(`${base}/cases/${ids[0]}`);
    expect(history.body.history[0]).toMatchObject({ type: 'assigned' });

    const un = await post(supervisor, `${base}/cases/assign`, {
      caseIds: ids.slice(0, 1),
      userId: null,
    });
    expect(un.body.changed).toBe(1);
    const back = await pm.agent.get(`${base}/cases/${ids[0]}`);
    expect(back.body).toMatchObject({ status: 'fresh', assignedTo: null });
  });

  it('assignment rules pick up matching unassigned cases, respecting quotas', async () => {
    const rule = await post(pm, `${base}/assignments`, {
      userId: interviewer2.id,
      name: 'Region 3',
      filter: 'case.region == 3',
      quota: 4,
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(
      (await post(pm, `${base}/assignments`, { userId: interviewer2.id, filter: 'Q1 == 1' }))
        .status,
    ).toBe(400);
    const preview = await post(pm, `${base}/assignments/preview`, { filter: 'case.region == 3' });
    expect(preview.body.matching).toBeGreaterThan(4);

    const applied = await post(pm, `${base}/assignments/apply`, {});
    expect(applied.body.assigned).toBe(4);
    const rules = await pm.agent.get(`${base}/assignments`);
    expect(rules.body[0]).toMatchObject({ assignedToUser: 4 });

    // New imports are assigned on commit while the quota allows.
    await sql`UPDATE assignments SET quota = NULL WHERE id = ${rule.body.id}`.execute(t.owner);
    const table = [
      [...sampleTable(0)[0]!],
      ['NEW1', 'Ana', 'Q', '3', 'Cusco', '30', '987654321', 'a@example.org', '0'],
    ];
    const { id } = await importTable(table);
    const done = await post(pm, `${base}/imports/${id}/commit`);
    expect(done.body).toMatchObject({ created: 1, assigned: 1 });
    const ppl = await pm.agent.get(`${base}/assignees`);
    const i2 = ppl.body.find((p: { userId: string }) => p.userId === interviewer2.id);
    expect(i2.workload.assigned).toBeGreaterThan(4);
  });

  it('edits cases with history; case history cannot be changed', async () => {
    const c = { id: await caseId('HH0010') };
    const r = await pm.agent
      .patch(`${base}/cases/${c.id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ priority: 9, status: 'withdrawn' });
    expect(r.body).toMatchObject({ priority: 9, status: 'withdrawn' });
    const assign = await post(supervisor, `${base}/cases/assign`, {
      caseIds: [c!.id],
      userId: interviewer.id,
    });
    expect(assign.body).toMatchObject({ changed: 0, skipped: 1 });
    await expect(
      sql`UPDATE case_events SET type = 'x' WHERE case_id = ${c.id}`.execute(t.owner),
    ).rejects.toThrow(/append-only/);
  });

  const patchProject = (s: Session, settings: object) =>
    s.agent.patch(`/api/v1/projects/${project}`).set('x-csrf-token', s.csrf).send({ settings });
  const autoViews = async (userId: string) =>
    (
      await rows(sql`SELECT target_id FROM audit_log WHERE action = 'case.pii_viewed'
        AND actor_user_id = ${userId} AND JSON_VALUE(details, '$.auto') = 'true'`)
    ).map((r) => (r.target_id as string).toLowerCase());

  it('shows interviewers the personal data of their cases, recording the first view of each', async () => {
    await sql`UPDATE projects SET languages = '["en","es"]', timezone = 'America/Lima' WHERE id = ${project}`.execute(
      t.owner,
    );
    const project0 = await pm.agent.get(`/api/v1/projects/${project}`);
    expect(project0.body.settings).toMatchObject({
      revealToInterviewers: true,
      assignmentMode: 'assigned',
    });
    const list = await interviewerS.agent.get(`${base}/cases`);
    expect(list.body.total).toBeGreaterThan(0);
    expect(
      list.body.rows.every(
        (r: { sample: { first_name: string } }) => r.sample.first_name !== '•••',
      ),
    ).toBe(true);
    const seen = await autoViews(interviewer.id);
    expect(new Set(seen).size).toBe(seen.length);
    // Every case listed to them is recorded (including ones they held earlier in this file).
    expect(seen).toEqual(expect.arrayContaining(list.body.rows.map((r: { id: string }) => r.id)));

    const id = list.body.rows[0].id as string;
    const d1 = await interviewerS.agent.get(`${base}/cases/${id}`);
    await interviewerS.agent.get(`${base}/cases/${id}`);
    expect(d1.body.pii).toEqual({ masked: false, canReveal: false, auto: true });
    expect(d1.body.contacts[0].value).not.toBe('•••');
    expect((await autoViews(interviewer.id)).filter((x) => x === id)).toHaveLength(1);
    // Supervisors and managers still reveal case by case.
    const byPm = await pm.agent.get(`${base}/cases/${id}`);
    expect(byPm.body.pii.masked).toBe(true);

    // Only project managers and admins change settings; unknown keys are refused.
    expect((await patchProject(supervisor, { revealToInterviewers: false })).status).toBe(403);
    expect((await patchProject(pm, { revealAll: true })).status).toBe(400);
    const off = await patchProject(pm, { revealToInterviewers: false });
    expect(off.body.settings).toMatchObject({
      revealToInterviewers: false,
      assignmentMode: 'assigned',
    });
    // Other project fields are left alone.
    expect(off.body).toMatchObject({ languages: ['en', 'es'], timezone: 'America/Lima' });
    const masked = await interviewerS.agent.get(`${base}/cases/${id}`);
    expect(masked.body.pii).toEqual({ masked: true, canReveal: true, auto: false });
    expect((await interviewerS.agent.get(`${base}/cases`)).body.rows[0].sample.first_name).toBe(
      '•••',
    );
    await patchProject(pm, { revealToInterviewers: true });
  });
});
