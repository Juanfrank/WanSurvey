import { sampleTable, toCsv } from '@wansurvey/fixtures';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSampleFile, sniffDelimiter } from '../src/cases/sample-file.js';
import {
  normalisePhone,
  parseDate,
  suggestMapping,
  validateRows,
  type ImportMapping,
} from '../src/cases/sample-mapping.js';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
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

describe('sample files', () => {
  it('reads CSV with BOM, semicolons, quoted newlines and Windows-1252', async () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    const text = '﻿id;name;note\n1;José;"two\nlines"\n';
    const utf8 = await parseSampleFile(Buffer.from(text, 'utf8'), 'x.csv', { maxRows: 10 });
    expect(utf8).toMatchObject({
      headers: ['id', 'name', 'note'],
      rows: [['1', 'José', 'two\nlines']],
      delimiter: ';',
      encoding: 'utf-8',
    });
    const latin = Buffer.from([
      0x69, 0x64, 0x2c, 0x6e, 0x0a, 0x31, 0x2c, 0x4a, 0x6f, 0x73, 0xe9, 0x0a,
    ]);
    const l = await parseSampleFile(latin, 'x.csv', { maxRows: 10 });
    expect(l.rows).toEqual([['1', 'José']]);
    expect(l.encoding).toBe('windows-1252');
    await expect(
      parseSampleFile(Buffer.from('a\n1\n2\n'), 'x.csv', { maxRows: 1 }),
    ).rejects.toThrow(/limit is 1/);
    await expect(parseSampleFile(Buffer.from('x'), 'x.pdf', { maxRows: 1 })).rejects.toThrow(/csv/);
  });

  it('reads XLSX, including dates', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['id', 'born']);
    ws.addRow([7, new Date(Date.UTC(1990, 4, 17))]);
    const f = await parseSampleFile(Buffer.from(await wb.xlsx.writeBuffer()), 'x.xlsx', {
      maxRows: 10,
    });
    expect(f).toMatchObject({
      headers: ['id', 'born'],
      rows: [['7', '1990-05-17']],
      sheets: ['S'],
    });
  });

  it('suggests a mapping and validates rows', () => {
    const [headers, ...rows] = sampleTable(20, true);
    const m = suggestMapping(headers!, rows);
    expect(m.columns.map((c) => c.kind)).toEqual([
      'externalId',
      'sample',
      'sample',
      'sample',
      'sample',
      'sample',
      'contact',
      'contact',
      'priority',
    ]);
    expect(m.columns[1]).toMatchObject({ field: 'first_name', pii: true });
    expect(m.columns[3]).toMatchObject({ field: 'region', type: 'number', pii: false });
    const { report, prepared } = validateRows(headers!, rows, m, new Set(['HH0002']));
    expect(report).toMatchObject({ total: 21, valid: 18, invalid: 3, existing: 1, toCreate: 17 });
    const codes = Object.fromEntries(report.issues.map((i) => [i.code, i.count]));
    expect(codes).toMatchObject({ invalid_email: 2, duplicate_id: 1, existing_id: 1 });
    expect(prepared[0]!.contacts.map((c) => c.type)).toEqual(['phone', 'email']);
  });

  it('normalises phones and dates', () => {
    expect(normalisePhone('(01) 234-5678', '51')).toBe('+5112345678');
    expect(normalisePhone('0051 1 2345678')).toBe('+5112345678');
    expect(normalisePhone('12')).toBeNull();
    expect(normalisePhone('abc')).toBeNull();
    expect(parseDate('17/05/1990')).toBe('1990-05-17');
    expect(parseDate('1990-02-30')).toBeNull();
  });
});

describe('cases API', () => {
  let t: TestApp;
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
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    supervisor = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'supervisor' }]));
    const clerkUser = await createUser(t.admin, tenant.id, [{ role: 'data_entry' }]);
    clerk = await login(t.app, clerkUser);
    interviewer = await createUser(t.admin, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    interviewerS = await login(t.app, interviewer);
    interviewer2 = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
    base = `/api/v1/projects/${project}`;
  });
  afterAll(() => t.close());

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

    const staged =
      await t.admin`select count(*)::int as n from sample_import_rows where import_id = ${id}`;
    expect(staged[0]!.n).toBe(0);
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
    const [c] =
      await t.admin`select sample from cases where project_id = ${project} and external_id = 'HH0001'`;
    expect((c!.sample as { city: string }).city).toBe('Trujillo');
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

  it('reveals personal data only on request, with an audit entry', async () => {
    const [c] =
      await t.admin`select id from cases where project_id = ${project} and external_id = 'HH0004'`;
    const masked = await pm.agent.get(`${base}/cases/${c!.id}`);
    expect(masked.body.contacts[0].value).toBe('•••');
    expect(masked.body.pii).toEqual({ masked: true, canReveal: true });
    const shown = await pm.agent.get(`${base}/cases/${c!.id}`).query({ reveal: 'pii' });
    expect(shown.body.sample.first_name).toBe('Luis');
    expect(shown.body.contacts.map((x: { value: string }) => x.value)).toContain(
      'luis.4@example.org',
    );
    const audit =
      await t.admin`select count(*)::int as n from audit_log where action = 'case.pii_viewed' and target_id = ${c!.id}`;
    expect(audit[0]!.n).toBe(1);
  });

  it('assigns in bulk only to eligible people; interviewers see only their cases', async () => {
    const ids = (
      await pm.agent.get(`${base}/cases`).query({ filter: 'case.region == 2' })
    ).body.rows.map((r: { id: string }) => r.id);
    const notEligible = await post(supervisor, `${base}/cases/assign`, {
      caseIds: ids,
      userId: (
        await t.admin`select id from users where email = ${(await createUser(t.admin, tenant.id, [{ role: 'reviewer' }])).email}`
      )[0]!.id,
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

    // The data entry clerk has no cases and no personal data.
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
    await t.admin`update assignments set quota = null where id = ${rule.body.id}`;
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
    const [c] =
      await t.admin`select id from cases where project_id = ${project} and external_id = 'HH0010'`;
    const r = await pm.agent
      .patch(`${base}/cases/${c!.id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ priority: 9, status: 'withdrawn' });
    expect(r.body).toMatchObject({ priority: 9, status: 'withdrawn' });
    const assign = await post(supervisor, `${base}/cases/assign`, {
      caseIds: [c!.id],
      userId: interviewer.id,
    });
    expect(assign.body).toMatchObject({ changed: 0, skipped: 1 });
    await expect(
      t.admin`update case_events set type = 'x' where case_id = ${c!.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it('keeps cases inside their tenant', async () => {
    const other = await createTenant(t.admin);
    const s = await login(t.app, await createUser(t.admin, other.id, [{ role: 'admin' }]));
    expect((await s.agent.get(`${base}/cases`)).status).toBe(404);
  });
});
