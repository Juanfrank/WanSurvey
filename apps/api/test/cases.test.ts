import { sampleTable, toCsv } from '@wansurvey/fixtures';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSampleFile, sniffDelimiter } from '../src/cases/sample-file.js';
import { deal, distribute, fairWeights, productivity, quotas } from '../src/cases/distribute.js';
import { ruleStrategy, STRATEGIES } from '../src/cases/strategies.js';
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

describe('assignment strategies', () => {
  const rule = (id: string, userId: string, filter: string, quota: number | null, at: number) => ({
    id,
    kind: 'rule',
    userId,
    filter,
    quota,
    createdAt: new Date(at),
  });
  const pool = [1, 2, 1, 1, 2].map((region, i) => ({
    id: `c${i}`,
    sample: { region },
    status: 'fresh',
    priority: 0,
    modePreference: null,
  }));

  it('runs rules oldest first, each taking what earlier rules left, within quotas', () => {
    const held = new Map([['u1', 1]]);
    const hands = ruleStrategy.plan({
      rules: [
        rule('late', 'u2', 'case.region == 1', null, 2),
        rule('early', 'u1', 'case.region == 1', 3, 1),
      ],
      pool,
      held,
      taken: new Set(),
    });
    expect(hands).toEqual([
      { ruleId: 'early', userId: 'u1', caseIds: ['c0', 'c2'] },
      { ruleId: 'late', userId: 'u2', caseIds: ['c3'] },
    ]);
    expect(held.get('u1')).toBe(3);
    expect(STRATEGIES.map((s) => s.kind)).toEqual(['rule']);
  });

  it('hands cases out at random and evenly, counting what people hold when asked', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const even = distribute(ids, ['a', 'b', 'c']);
    const sizes = [...even.values()].map((x) => x.length).sort();
    expect(sizes).toEqual([3, 3, 4]);
    expect([...even.values()].flat().sort()).toEqual([...ids].sort());
    // b already holds 4: with the 10 new ones both end with 7.
    const balanced = distribute(ids, ['a', 'b'], new Map([['b', 4]]));
    expect(balanced.get('a')!.length).toBe(7);
    expect(balanced.get('b')!.length).toBe(3);
  });

  it('shares in proportion to weights, by largest remainder', () => {
    const w = new Map([
      ['a', 2],
      ['b', 1],
      ['c', 1],
    ]);
    expect(Object.fromEntries(quotas(['a', 'b', 'c'], w, 10))).toEqual(
      expect.objectContaining({ a: 5 }),
    );
    const q = quotas(['a', 'b', 'c'], w, 10);
    expect(q.get('b')! + q.get('c')!).toBe(5);
    expect(Math.abs(q.get('b')! - q.get('c')!)).toBeLessThanOrEqual(1);
    // Evening out: a already holds 12 of a total of 22, past its half, so gets none.
    const even = quotas(['a', 'b', 'c'], w, 10, new Map([['a', 12]]));
    expect(even.get('a')).toBe(0);
    expect(even.get('b')).toBe(5);
    expect(even.get('c')).toBe(5);
    // Every case is given, whatever the weights.
    for (let n = 0; n < 40; n++) {
      const r = quotas(
        ['a', 'b', 'c'],
        new Map([
          ['a', 3.3],
          ['b', 1.1],
          ['c', 0.7],
        ]),
        n,
      );
      expect([...r.values()].reduce((s, v) => s + v, 0)).toBe(n);
    }
  });

  it('stops at each person’s limit, shares the rest, and leaves what no one has room for', () => {
    const w = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    const capped = quotas(['a', 'b'], w, 10, new Map(), new Map([['a', 2]]));
    expect(Object.fromEntries(capped)).toEqual({ a: 2, b: 8 });
    const full = quotas(
      ['a', 'b'],
      w,
      10,
      new Map(),
      new Map([
        ['a', 2],
        ['b', 3],
      ]),
    );
    expect(Object.fromEntries(full)).toEqual({ a: 2, b: 3 });
    const hands = deal(
      Array.from({ length: 6 }, (_, i) => `c${i}`),
      new Map([
        ['a', 2],
        ['b', 3],
      ]),
    );
    expect(hands.get('a')).toHaveLength(2);
    expect(hands.get('b')).toHaveLength(3);
    expect(new Set([...hands.values()].flat()).size).toBe(5);
  });

  it('weighs productivity, pulled towards the team’s for people with little history', () => {
    const p = productivity(
      ['fast', 'slow', 'new'],
      new Map([
        ['fast', { completes: 60, days: 10 }],
        ['slow', { completes: 20, days: 10 }],
      ]),
    );
    // The team does 4 a day: the newcomer starts there.
    expect(p.get('new')).toBeCloseTo(4);
    expect(p.get('fast')!).toBeGreaterThan(5);
    expect(p.get('fast')!).toBeLessThan(6);
    expect(p.get('slow')!).toBeGreaterThan(2);
    // No history at all: everyone the same.
    expect([...productivity(['a', 'b'], new Map()).values()]).toEqual([1, 1]);
  });

  it('keeps the fair weights within 20% of the mean, softened by the square root', () => {
    const f = fairWeights(
      new Map([
        ['star', 16],
        ['mid', 4],
        ['low', 1],
      ]),
    );
    expect(f.get('star')).toBeCloseTo(1.2);
    expect(f.get('low')).toBeCloseTo(0.8);
    expect(f.get('mid')!).toBeGreaterThan(0.8);
    expect(f.get('mid')!).toBeLessThan(1.2);
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
    const clerkUser = await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]);
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
    expect(masked.body.pii).toEqual({ masked: true, canReveal: true, auto: false });
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

  const patchProject = (s: Session, settings: object) =>
    s.agent.patch(`/api/v1/projects/${project}`).set('x-csrf-token', s.csrf).send({ settings });
  const autoViews = async (userId: string) =>
    (
      await t.admin`select target_id from audit_log where action = 'case.pii_viewed'
        and actor_user_id = ${userId} and details->>'auto' = 'true'`
    ).map((r) => r.target_id as string);

  it('shows interviewers the personal data of their cases, recording the first view of each', async () => {
    await t.admin`update projects set languages = '{en,es}', timezone = 'America/Lima' where id = ${project}`;
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

  it('pool mode: free cases are open to interviewers, the first claim wins', async () => {
    const free = (
      await pm.agent.get(`${base}/cases`).query({ assignedTo: 'none', status: 'fresh' })
    ).body.rows as { id: string }[];
    expect(free.length).toBeGreaterThan(1);
    const notPool = await post(interviewerS, `${base}/cases/${free[0]!.id}/claim`);
    expect(notPool.status).toBe(400);
    expect(notPool.body.code).toBe('NOT_POOL');
    expect((await interviewerS.agent.get(`${base}/cases/${free[0]!.id}`)).status).toBe(404);

    const on = await patchProject(pm, { assignmentMode: 'pool' });
    expect(on.body.settings.assignmentMode).toBe('pool');
    const other = await login(t.app, interviewer2);
    const visible = await interviewerS.agent.get(`${base}/cases`).query({ limit: 200 });
    expect(visible.body.assignmentMode).toBe('pool');
    const ids = visible.body.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(free.map((f) => f.id)));
    // Free cases are not theirs yet: masked, and no view is recorded.
    const freeRow = visible.body.rows.find((r: { id: string }) => r.id === free[0]!.id);
    expect(freeRow.sample.first_name).toBe('•••');
    expect(await autoViews(interviewer.id)).not.toContain(free[0]!.id);
    const before = await interviewerS.agent.get(`${base}/cases/${free[0]!.id}`);
    expect(before.body).toMatchObject({ canClaim: true, canRelease: false });
    expect(before.body.pii.masked).toBe(true);

    const target = free[0]!.id;
    // Roles that do not work cases may neither claim nor release.
    const reviewer = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'reviewer' }]),
    );
    expect((await post(reviewer, `${base}/cases/${target}/claim`)).status).toBe(403);
    expect((await post(reviewer, `${base}/cases/${target}/release`)).status).toBe(403);
    const [a, b] = await Promise.all([
      post(interviewerS, `${base}/cases/${target}/claim`),
      post(other, `${base}/cases/${target}/claim`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('ALREADY_TAKEN');
    const [winner, winnerUser, loserS] =
      a.status === 200 ? [interviewerS, interviewer, other] : [other, interviewer2, interviewerS];
    expect((await loserS.agent.get(`${base}/cases/${target}`)).status).toBe(404);
    const held = await winner.agent.get(`${base}/cases/${target}`);
    expect(held.body).toMatchObject({
      status: 'assigned',
      assignedTo: winnerUser.id,
      canRelease: true,
      canClaim: false,
    });
    expect(held.body.history[0]).toMatchObject({ type: 'claimed' });

    // Someone else's case cannot be released by another interviewer; the holder can.
    expect((await post(loserS, `${base}/cases/${target}/release`)).status).toBe(404);
    const rel = await post(winner, `${base}/cases/${target}/release`);
    expect(rel.body).toEqual({ released: true });
    const back = await pm.agent.get(`${base}/cases/${target}`);
    expect(back.body).toMatchObject({ status: 'fresh', assignedTo: null });
    expect(back.body.history[0]).toMatchObject({ type: 'released' });
    const audit =
      await t.admin`select action from audit_log where target_id = ${target} and action in ('case.claimed', 'case.released')`;
    expect(audit.map((r) => r.action).sort()).toEqual(['case.claimed', 'case.released']);

    // Imports do not run the rules in pool mode.
    const table = [
      [...sampleTable(0)[0]!],
      ['POOL1', 'Eva', 'R', '3', 'Cusco', '41', '987654322', 'e@example.org', '0'],
    ];
    const { id } = await importTable(table);
    const done = await post(pm, `${base}/imports/${id}/commit`);
    expect(done.body).toMatchObject({ created: 1, assigned: 0 });
    await patchProject(pm, { assignmentMode: 'assigned' });
  });

  it('previews and shares out by capacity, productivity and the fair method', async () => {
    const ids = (await pm.agent.get(`${base}/cases`).query({ pageSize: 200 })).body.rows
      .filter((r: { status: string }) => r.status === 'fresh' || r.status === 'assigned')
      .map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThan(2);
    const people = [interviewer.id, interviewer2.id];
    const preview = (body: object) =>
      post(pm, `${base}/cases/distribute/preview`, { caseIds: ids, userIds: people, ...body });
    type Row = { userId: string; receive: number; limit: number | null };
    const by = (rows: Row[]): Record<string, Row> =>
      Object.fromEntries(rows.map((r) => [r.userId, r]));

    // Manual weights 3 to 1.
    const manual = await preview({
      method: 'capacity',
      weights: { [people[0]!]: 3, [people[1]!]: 1 },
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    const m = by(manual.body.rows);
    expect(m[people[0]!]!.receive + m[people[1]!]!.receive).toBe(ids.length);
    expect(m[people[0]!]!.receive).toBe(Math.round((ids.length * 3) / 4));
    expect(m[people[0]!]!).toMatchObject({ source: 'manual', share: 0.75 });

    // From goals: one person has a goal of their own, the other shares the team's.
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const goal = (userId: string | null, target: number) =>
      post(pm, `/api/v1/projects/${project}/goals`, {
        userId,
        frequency: 'daily',
        startsOn: day(-2),
        endsOn: day(2),
        target,
      }).expect(201);
    const g1 = await goal(people[0]!, 6);
    const g2 = await goal(null, 4);
    const goals = by((await preview({ method: 'capacity' })).body.rows);
    expect(goals[people[0]!]!).toMatchObject({ source: 'goal', weight: 6 });
    expect(goals[people[1]!]!).toMatchObject({ source: 'team_goal', weight: 2 });
    for (const g of [g1, g2])
      await pm.agent
        .delete(`/api/v1/projects/${project}/goals/${g.body.id}`)
        .set('x-csrf-token', pm.csrf)
        .expect(200);

    // No interviews yet: productivity weighs everyone the same.
    const perf = by((await preview({ method: 'performance', days: 30 })).body.rows);
    expect(perf[people[0]!]!).toMatchObject({ source: 'output', weight: 1 });
    expect(Math.abs(perf[people[0]!]!.receive - perf[people[1]!]!.receive)).toBeLessThanOrEqual(1);

    // The fair method with a cap of 1 open case: the rest stays free.
    const fair = await preview({ method: 'fair', cap: 1 });
    const f = by(fair.body.rows);
    expect(f[people[0]!]!.limit).toBeLessThanOrEqual(1);
    expect(fair.body.free).toBe(ids.length - f[people[0]!]!.receive - f[people[1]!]!.receive);

    // A preview assigns nothing; the share-out does, and says what stayed free.
    const done = await post(pm, `${base}/cases/distribute`, {
      caseIds: ids,
      userIds: people,
      method: 'capacity',
      weights: { [people[0]!]: 3, [people[1]!]: 1 },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.perPerson[people[0]!]).toBe(m[people[0]!]!.receive);
    expect(done.body.free).toBe(0);
    expect(
      (await post(interviewerS, `${base}/cases/distribute/preview`, { userIds: people })).status,
    ).toBe(403);
  });

  it('distributes cases at random and evenly among the people chosen', async () => {
    const ids = (await pm.agent.get(`${base}/cases`).query({ pageSize: 200 })).body.rows
      .filter((r: { status: string }) => r.status === 'fresh' || r.status === 'assigned')
      .map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThan(2);
    const res = await post(supervisor, `${base}/cases/distribute`, {
      caseIds: ids,
      userIds: [interviewer.id, interviewer2.id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const counts = Object.values(res.body.perPerson as Record<string, number>);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(ids.length);
    expect(Math.abs(counts[0]! - counts[1]!)).toBeLessThanOrEqual(1);
    expect(
      (
        await post(interviewerS, `${base}/cases/distribute`, {
          caseIds: ids,
          userIds: [interviewer.id],
        })
      ).status,
    ).toBe(403);
  });

  it('keeps cases inside their tenant', async () => {
    const other = await createTenant(t.admin);
    const s = await login(t.app, await createUser(t.admin, other.id, [{ role: 'admin' }]));
    expect((await s.agent.get(`${base}/cases`)).status).toBe(404);
  });
});
