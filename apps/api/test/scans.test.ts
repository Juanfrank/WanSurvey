import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/jobs/jobs.service.js';
import { ScansService } from '../src/papi/scans.service.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
} from './harness.js';
import { fillAndScan } from './support/scan.js';

/** Scanned paper forms: printed with a code per page, read back, finished by hand. */
describe('scanned paper forms', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let pm: Session;
  let clerk: Session;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    clerk = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]),
    );
    for (const ext of ['P001', 'P002']) {
      ids[ext] = uuidv7();
      await t.admin`insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, status)
        values (${ids[ext]!}, ${tenant.id}, ${project}, ${qid}, ${ext}, ${t.admin.json({ city: 'Lima' })}, 'fresh')`;
    }
  });
  afterAll(() => t.close());

  const base = () => `/api/v1/projects/${project}/papi`;

  it('prints the forms, splits a PDF of two, reads the marks, and leaves the rest for the second round', async () => {
    const pdf = await pm.agent
      .get(`${base()}/scan-forms.pdf`)
      .query({ questionnaireId: qid, caseIds: `${ids.P001},${ids.P002}` })
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['x-form-count']).toBe('2');

    // The layout the reader will use.
    const [v] =
      await t.admin`select id, compiled from questionnaire_versions where questionnaire_id = ${qid}`;
    const compiled = v!.compiled as CompiledQuestionnaire;
    const layout = await t.app
      .get(ScansService)
      .layout(v!.id as string, compiled, compiled.questionnaire.defaultLanguage);
    const consent = layout.questions.find((q) => q.name === 'A1_CONSENT')!;
    const yes = consent.bubbles.find((b) => b.code === 1)!;
    const no = consent.bubbles.find((b) => b.code === 2)!;
    const sex = layout.questions.find((q) => q.name === 'A3_SEX');
    // P001 accepts (and has two marks on sex, if it is on paper); P002 refuses, which ends it.
    const marks = [yes, { ...no, page: no.page + layout.pages }];
    if (sex) marks.push(sex.bubbles[0]!, sex.bubbles[1]!);
    // The scanner took the pages in a different order.
    const order = Array.from({ length: layout.pages * 2 }, (_, i) => i).reverse();
    const scan = await fillAndScan(pdf.body as Buffer, marks, { order });

    const notPdf = await clerk.agent
      .post(`${base()}/scans`)
      .set('x-csrf-token', clerk.csrf)
      .attach('files', Buffer.from('hello'), 'x.pdf');
    expect(notPdf.status).toBe(422);
    const up = await clerk.agent
      .post(`${base()}/scans`)
      .set('x-csrf-token', clerk.csrf)
      .attach('files', scan, 'lote-1.pdf');
    expect(up.status, JSON.stringify(up.body)).toBe(202);

    await t.app.get(JobsService).drain();
    const list = await clerk.agent.get(`${base()}/scans`).expect(200);
    const batch = list.body[0];
    expect(batch).toMatchObject({
      fileName: 'lote-1.pdf',
      status: 'done',
      pages: layout.pages * 2,
    });
    expect(batch.unreadPages).toEqual([]);
    const byCase = Object.fromEntries(
      batch.forms.map((f: { externalId: string }) => [f.externalId, f]),
    );
    // P002 refused: complete, nothing to check, submitted at once.
    expect(byCase.P002).toMatchObject({ status: 'done', pagesExpected: layout.pages });
    const [c2] = await t.admin`select status, disposition from cases where id = ${ids.P002!}`;
    expect(c2).toMatchObject({ status: 'finalised', disposition: 'REFUSAL' });
    // P001 goes on: handwritten answers (age) and, if printed, the doubly marked sex.
    expect(byCase.P001.status).toBe('review');
    const issues = byCase.P001.issues as { name: string; kind: string }[];
    expect(issues).toEqual(expect.arrayContaining([{ name: 'A2_AGE', kind: 'manual' }]));
    if (sex) expect(issues.find((i) => i.name === 'A3_SEX')?.kind).toMatch(/multiple|manual/);
    const [ans] =
      await t.admin`select answers from interviews where id = ${byCase.P001.interviewId}`;
    expect(ans!.answers).toMatchObject({ A1_CONSENT: 1 });

    // The second round: the clerk takes the form; its interview tells where each question is.
    const claimed = await clerk.agent
      .post(`${base()}/scans/forms/${byCase.P001.id}/claim`)
      .set('x-csrf-token', clerk.csrf)
      .expect(200);
    const info = await clerk.agent.get(`/api/v1/interviews/${claimed.body.interviewId}/scan`);
    expect(info.status, JSON.stringify(info.body)).toBe(200);
    const age = info.body.questions.A2_AGE;
    expect(age).toMatchObject({ reading: 'manual', issue: { kind: 'manual' } });
    expect(age.areas[0].w).toBeGreaterThan(0.5);
    const img = await clerk.agent.get(`${base()}/scans/pages/${age.areas[0].pageId}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    // The interview opens for the clerk like any keyed form.
    await clerk.agent.get(`/api/v1/interviews/${claimed.body.interviewId}`).expect(200);
  }, 120_000);
});
