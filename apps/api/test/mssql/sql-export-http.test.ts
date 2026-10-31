import { allTypes, household } from '@wansurvey/fixtures';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simulateInterview } from '../../src/db/simulate.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { createQuestionnaire } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type Session,
  type MssqlTestApp,
} from './harness.js';

type Cell = string | number | null;

/** A cell as both sides write it: numbers compared as numbers, empty as null. */
const norm = (v: unknown): Cell => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && 'richText' in (v as object))
    return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  const n = Number(v);
  if (typeof v !== 'boolean' && String(v).trim() !== '' && Number.isFinite(n)) return n;
  return String(v);
};

/**
 * The SQL export rebuilds the Excel export from the analysis model (schema bi): same sheets,
 * columns, order and cells, whatever the options and the questionnaire.
 */
describe.skipIf(!configured)('SQL Server: SQL export, the counterpart of Excel', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;
  const questionnaires: Record<string, string> = {};

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    pm = await login(t, await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]));
    const interviewer = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    const modes = ['CATI', 'CAPI', 'CAWI', 'PAPI'];
    for (const [key, def] of Object.entries({ household, allTypes })) {
      const qid = await createQuestionnaire(t.owner, tenant.id, project, {
        publish: true,
        definition: def,
      });
      questionnaires[key] = qid;
      const v = (
        (await sql<{
          id: string;
          compiled: string;
        }>`SELECT id, compiled FROM questionnaire_versions WHERE questionnaire_id = ${qid}`.execute(
          t.owner,
        )) as { rows: { id: string; compiled: string }[] }
      ).rows[0]!;
      const compiled = JSON.parse(v.compiled) as CompiledQuestionnaire;
      for (let n = 0; n < 14; n++) {
        const s = simulateInterview(compiled, { mode: modes[n % 4]!, seed: `${key}-${n}` });
        const answers = s.getAnswers() as Record<string, unknown>;
        // Special answers, an empty multiple choice and a refused grid, as devices send them.
        if (n === 1)
          for (const k of ['A3_SEX', 'SINGLE', 'NUM'])
            if (k in answers) answers[k] = { $special: 'DK' };
        if (n === 2) for (const k of ['C7_APPL', 'MULTI']) if (k in answers) answers[k] = [];
        if (n === 3)
          for (const k of ['D6_GRID', 'GRID', 'MULTI', 'RANK'])
            if (k in answers) answers[k] = { $special: 'RF' };
        const id = randomUUID();
        const caseId = randomUUID();
        await sql`INSERT INTO cases (id, tenant_id, project_id, questionnaire_id, external_id, status)
          VALUES (${caseId}, ${tenant.id}, ${project}, ${qid}, ${`${key}-${n}`}, 'finalised')`.execute(
          t.owner,
        );
        // One returned interview and one second keying, which the exports leave out.
        const status = n === 5 ? 'returned' : n % 3 === 0 ? 'approved' : 'submitted';
        const at = new Date(Date.UTC(2026, 9, 1 + n, 15, n, 7, 123));
        const instant = (d: Date) => sql`CAST(${d.toISOString()} AS datetimeoffset(3))`;
        await sql`INSERT INTO interviews (id, tenant_id, project_id, case_id, questionnaire_version_id,
            mode, interviewer_id, status, disposition, language, device_id, answers, flags,
            entry_pass, started_at, submitted_at, active_ms)
          VALUES (${id}, ${tenant.id}, ${project}, ${caseId}, ${v.id}, ${modes[n % 4]!}, ${interviewer.id},
            ${status}, ${s.status().disposition ?? 'COMPLETE'}, 'es', 'd1', ${JSON.stringify(answers)},
            ${JSON.stringify(n % 4 === 0 ? { speeding: {}, straightlining: {} } : {})},
            ${n === 6 ? 2 : 1}, ${instant(new Date(at.getTime() - 600_500))}, ${instant(at)}, ${600_500 + n})`.execute(
          t.owner,
        );
        for (const [seq, type] of [
          'enter_question',
          'navigate_back',
          'note_added',
          'pause',
          'warning_confirmed',
        ]
          .slice(0, n % 6)
          .entries())
          await sql`INSERT INTO interview_paradata (id, tenant_id, interview_id, device_id, seq, type, at, payload)
            VALUES (${randomUUID()}, ${tenant.id}, ${id}, 'd1', ${seq + 1}, ${type}, CAST(${at.toISOString()} AS datetimeoffset(3)),
              ${JSON.stringify({ key: 'HH[1].M_AGE', ms: 1500 })})`.execute(t.owner);
      }
    }
    await t.app.get(JobsService).run('bi.refresh', {});
  }, 120_000);
  afterAll(() => t.close());

  const download = async (id: string) =>
    (
      await pm.agent
        .get(`/api/v1/projects/${project}/exports/${id}/file`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200)
    ).body as Buffer;

  const cases = [
    { fixture: 'household', options: { labels: 'codes', rosters: 'wide', paradata: true } },
    { fixture: 'household', options: { labels: 'labels', rosters: 'long' } },
    { fixture: 'allTypes', options: { labels: 'labels', rosters: 'wide', paradata: true } },
    { fixture: 'allTypes', options: { labels: 'codes', rosters: 'long', mode: 'CAPI' } },
    {
      fixture: 'household',
      options: { labels: 'codes', rosters: 'wide', approvedOnly: true, from: '2026-10-03' },
    },
  ] as const;

  it('keeps a questionnaire name on its comment line, and refuses such names', async () => {
    const qid = questionnaires.household!;
    // A name stored before names were checked: its line break must not become a statement.
    await sql`UPDATE questionnaires SET name = ${'Hogares\nupdate users set name = 1;--'} WHERE id = ${qid}`.execute(
      t.owner,
    );
    const e = await pm.agent
      .post(`/api/v1/projects/${project}/exports`)
      .set('x-csrf-token', pm.csrf)
      .send({ questionnaireId: qid, format: 'sql' })
      .expect(201);
    await t.app.get(JobsService).drain();
    const text = (await download(e.body.id)).toString('utf8');
    expect(text.split('\n').some((l) => /^\s*update users/i.test(l))).toBe(false);
    expect(text).toContain('-- WanSurvey · Hogares update users');
    const renamed = await pm.agent
      .patch(`/api/v1/projects/${project}/questionnaires/${qid}`)
      .set('x-csrf-token', pm.csrf)
      .send({ name: 'Uno\ndos' });
    expect(renamed.status).toBe(400);
    await sql`UPDATE questionnaires SET name = 'Hogares' WHERE id = ${qid}`.execute(t.owner);
  });

  it.each(cases)(
    'gives the same sheets as Excel: $fixture $options',
    async ({ fixture, options }) => {
      const body = { questionnaireId: questionnaires[fixture], ...options };
      const post = (format: string) =>
        pm.agent
          .post(`/api/v1/projects/${project}/exports`)
          .set('x-csrf-token', pm.csrf)
          .send({ ...body, format })
          .expect(201);
      const xlsx = await post('xlsx');
      const sqlExport = await post('sql');
      await t.app.get(JobsService).drain();
      const list = await pm.agent.get(`/api/v1/projects/${project}/exports`).expect(200);
      const done = (id: string) => list.body.find((e: { id: string }) => e.id === id);
      expect(done(sqlExport.body.id), JSON.stringify(done(sqlExport.body.id))).toMatchObject({
        status: 'done',
      });

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await download(xlsx.body.id)) as never);
      const text = (await download(sqlExport.body.id)).toString('utf8');
      expect(text).toMatch(/^-- WanSurvey/);
      // One query per data sheet (the variables and values sheets are the codebook).
      const statements = text
        .split(/;\n/)
        .map((s) => s.replace(/^(--.*\n|\s*\n)*/g, '').trim())
        .filter(Boolean);
      const sheets = wb.worksheets.filter((w) => w.name !== 'variables' && w.name !== 'values');
      expect(statements).toHaveLength(sheets.length);

      for (const [i, ws] of sheets.entries()) {
        const excel: Cell[][] = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const width = ws.getRow(1).cellCount;
          excel.push(Array.from({ length: width }, (_, k) => norm(row.getCell(k + 1).value)));
        });
        const [header, ...rows] = excel;
        // The columns come from the statement itself, so a sheet with no rows still has its header.
        const columns = (
          (await sql<{ name: string }>`
            SELECT name FROM sys.dm_exec_describe_first_result_set(${statements[i]!}, NULL, 0)
            ORDER BY column_ordinal`.execute(t.owner)) as { rows: { name: string }[] }
        ).rows.map((c) => c.name);
        expect(columns, ws.name).toEqual(header);
        const result = (
          (await sql.raw(statements[i]!).execute(t.owner)) as { rows: Record<string, unknown>[] }
        ).rows;
        expect(result.length, ws.name).toBe(rows.length);
        if (i === 0) expect(result.length).toBeGreaterThan(0);
        // The special answers and the empty multiple choice are there, not only empty cells.
        if (
          i === 0 &&
          fixture === 'household' &&
          options.labels === 'codes' &&
          !('from' in options)
        ) {
          const all = rows.flat();
          expect(all).toContain(-8);
          expect(all).toContain(-9);
        }
        result.forEach((r, n) =>
          expect(
            columns.map((c) => norm(r[c])),
            `${ws.name} row ${n + 1}`,
          ).toEqual(rows[n]),
        );
      }
    },
    60_000,
  );
});
