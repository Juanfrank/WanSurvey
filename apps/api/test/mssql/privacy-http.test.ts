import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { BiService } from '../../src/stats/bi.service.js';
import { PRIVACY_REPO, type PrivacyRepo } from '../../src/privacy/privacy-repo.js';
import { PrivacyService } from '../../src/privacy/privacy.service.js';
import { createQuestionnaire } from './fixtures.js';
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

const es = (text: string) => ({ es: text });
const definition = {
  id: 'PRIV',
  title: es('Privacidad'),
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: es('¿Edad?') },
        {
          kind: 'question',
          id: 'PHONE',
          name: 'PHONE',
          type: 'text',
          personal: true,
          text: es('¿Teléfono?'),
        },
      ],
    },
  ],
};

/**
 * Personal data on SQL Server over HTTP, the counterpart of test/privacy.test.ts: personal sample
 * fields sealed, a data subject's access request, erasure from every copy (including the
 * append-only history, through the owner procedures), and retention.
 */
describe.skipIf(!configured)('SQL Server: personal data over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let version: string;
  let pm: Session;
  let me: Session;
  let iUser: TestUser;
  let privacy: PrivacyService;

  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const json = (v: unknown) => JSON.stringify(v);

  beforeAll(async () => {
    t = await bootstrap();
    privacy = t.app.get(PrivacyService);
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    const qid = await createQuestionnaire(t.owner, tenant.id, project, {
      definition,
      publish: true,
    });
    version = (
      await rows(sql`SELECT id FROM questionnaire_versions WHERE questionnaire_id = ${qid}`)
    )[0]!.id as string;
    version = version.toLowerCase();
    for (const [name, pii] of [
      ['first_name', 1],
      ['last_name', 1],
      ['region', 0],
    ] as const)
      await sql`INSERT INTO sample_fields (id, tenant_id, project_id, name, type, pii)
                VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${name}, 'text', ${pii})`.execute(
        t.owner,
      );
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
    iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t, iUser, tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  const base = () => `/api/v1/projects/${project}`;
  async function newCase(sample: Record<string, unknown>, status = 'assigned') {
    const id = randomUUID();
    await sql`INSERT INTO cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
              VALUES (${id}, ${tenant.id}, ${project}, ${'P' + id.slice(-6)}, ${json(sample)},
                ${status}, ${iUser.id})`.execute(t.owner);
    return id;
  }
  const seal = () =>
    t.app
      .get<PrivacyRepo>(PRIVACY_REPO)
      .inTenant(tenant.id, (tx) => privacy.sealProject(tx, project));

  it('seals personal sample fields, still shown on reveal and found by name', async () => {
    const id = await newCase({ first_name: 'Rosa María', last_name: 'Quispe', region: 2 });
    expect(await seal()).toBe(1);
    const [row] = await rows(
      sql`SELECT sample, sample_pii, sample_pii_index FROM cases WHERE id = ${id}`,
    );
    expect(JSON.parse(row!.sample as string)).toEqual({ region: 2 });
    expect(row!.sample_pii).toMatch(/^v1\./);
    expect(row!.sample_pii).not.toContain('Rosa');
    expect(JSON.parse(row!.sample_pii_index as string)).toHaveLength(3);
    expect(await seal()).toBe(0);

    const shown = await pm.agent.get(`${base()}/cases/${id}`).query({ reveal: 'pii' });
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.sample).toEqual({ first_name: 'Rosa María', last_name: 'Quispe', region: 2 });
    const masked = await pm.agent.get(`${base()}/cases/${id}`);
    expect(masked.body.sample.first_name).not.toBe('Rosa María');

    // Whole words of sealed fields, accents and case ignored.
    const found = await pm.agent.get(`${base()}/cases`).query({ q: 'maria quispe' });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.rows.map((r: { id: string }) => r.id)).toEqual([id]);
    const none = await pm.agent.get(`${base()}/cases`).query({ q: 'ros' });
    expect(none.body.rows).toEqual([]);

    // Edits keep personal fields sealed.
    const edit = await pm.agent
      .patch(`${base()}/cases/${id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ sample: { first_name: 'Ana', region: 3 } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const [after] = await rows(sql`SELECT sample, sample_pii FROM cases WHERE id = ${id}`);
    expect(JSON.parse(after!.sample as string)).toEqual({ region: 3 });
    const again = await pm.agent.get(`${base()}/cases/${id}`).query({ reveal: 'pii' });
    expect(again.body.sample).toMatchObject({ first_name: 'Ana', last_name: 'Quispe' });
  });

  async function interviewed() {
    const caseId = await newCase({ first_name: 'Luis', region: 1 }, 'finalised');
    await seal();
    await sql`INSERT INTO contacts (id, tenant_id, case_id, type, value)
              VALUES (${randomUUID()}, ${tenant.id}, ${caseId}, 'phone', '+51987654321')`.execute(
      t.owner,
    );
    const iv = randomUUID();
    const answers = { AGE: 40, PHONE: '987654321' };
    await sql`INSERT INTO interviews (id, tenant_id, project_id, case_id, questionnaire_version_id, mode,
        interviewer_id, status, disposition, language, answers, state, context, device_id, submitted_at)
      VALUES (${iv}, ${tenant.id}, ${project}, ${caseId}, ${version}, 'CAPI', ${iUser.id}, 'submitted',
        'COMPLETE', 'es', ${json(answers)}, ${json({ answers, stash: {} })},
        ${json({ case: { first_name: 'Luis' } })}, 'dev-p', SYSDATETIMEOFFSET())`.execute(t.owner);
    await sql`INSERT INTO interview_answer_events (id, tenant_id, interview_id, device_id, seq, variable, old_value, new_value, at, source)
      VALUES (${randomUUID()}, ${tenant.id}, ${iv}, 'dev-p', 1, 'PHONE', NULL, ${json('987654321')}, SYSDATETIMEOFFSET(), 'interviewer'),
             (${randomUUID()}, ${tenant.id}, ${iv}, 'dev-p', 2, 'AGE', NULL, ${json(40)}, SYSDATETIMEOFFSET(), 'interviewer')`.execute(
      t.owner,
    );
    await sql`INSERT INTO interview_paradata (id, tenant_id, interview_id, device_id, seq, type, at, payload)
      VALUES (${randomUUID()}, ${tenant.id}, ${iv}, 'dev-p', 1, 'note_added', SYSDATETIMEOFFSET(),
        ${json({ key: 'AGE', text: 'Vive con Luis' })})`.execute(t.owner);
    return { caseId, iv };
  }

  it("answers a data subject's access request, then erases what is personal", async () => {
    const { caseId, iv } = await interviewed();
    expect((await me.agent.get(`${base()}/cases/${caseId}/subject-data`)).status).toBe(403);
    const data = await pm.agent.get(`${base()}/cases/${caseId}/subject-data`);
    expect(data.status, JSON.stringify(data.body)).toBe(200);
    expect(data.body.case.sample).toEqual({ first_name: 'Luis', region: 1 });
    expect(data.body.contacts[0].value).toBe('+51987654321');
    expect(data.body.interviews[0].answers).toEqual({ AGE: 40, PHONE: '987654321' });

    const noNote = await pm.agent
      .post(`${base()}/cases/${caseId}/erase`)
      .set('x-csrf-token', pm.csrf)
      .send({});
    expect(noNote.status).toBe(400);
    const erased = await pm.agent
      .post(`${base()}/cases/${caseId}/erase`)
      .set('x-csrf-token', pm.csrf)
      .send({ note: 'Solicitud ARCO 2026-17' });
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    expect(erased.body).toEqual({ interviews: 1, contacts: 1 });

    const [c] = await rows(
      sql`SELECT sample, sample_pii, anonymised_at FROM cases WHERE id = ${caseId}`,
    );
    expect(JSON.parse(c!.sample as string)).toEqual({ region: 1 });
    expect(c!.sample_pii).toBeNull();
    expect(c!.anonymised_at).not.toBeNull();
    const [i] = await rows(sql`SELECT answers, state, context FROM interviews WHERE id = ${iv}`);
    expect(JSON.parse(i!.answers as string)).toEqual({ AGE: 40 });
    expect(JSON.parse(i!.state as string)).toMatchObject({ answers: { AGE: 40 } });
    expect(JSON.parse(i!.context as string)).toEqual({});
    const events = await rows(
      sql`SELECT variable, new_value FROM interview_answer_events WHERE interview_id = ${iv} ORDER BY seq`,
    );
    expect(
      events.map((e) => [
        e.variable,
        e.new_value === null ? null : JSON.parse(e.new_value as string),
      ]),
    ).toEqual([
      ['PHONE', null],
      ['AGE', 40],
    ]);
    const [note] = await rows(
      sql`SELECT payload FROM interview_paradata WHERE interview_id = ${iv}`,
    );
    expect(JSON.parse(note!.payload as string)).toEqual({ key: 'AGE' });
    expect(await rows(sql`SELECT 1 AS x FROM contacts WHERE case_id = ${caseId}`)).toHaveLength(0);
    const audit = await rows(
      sql`SELECT action, details FROM audit_log WHERE target_id = ${caseId} ORDER BY at, id`,
    );
    expect(audit.map((a) => a.action)).toEqual(['case.subject_exported', 'case.anonymised']);
    expect(JSON.parse(audit[1]!.details as string)).toMatchObject({
      reason: 'request',
      note: 'Solicitud ARCO 2026-17',
    });
  });

  it('erases the other copies too: frame unit, import report, double entry, scans, the model', async () => {
    const { caseId, iv } = await interviewed();
    const imp = randomUUID();
    const mapping = {
      columns: [
        { kind: 'externalId' },
        { kind: 'sample', field: 'first_name', pii: true },
        { kind: 'contact', type: 'email' },
        { kind: 'sample', field: 'region', type: 'number' },
      ],
    };
    const report = {
      total: 2,
      valid: 1,
      invalid: 1,
      existing: 0,
      toCreate: 1,
      toUpdate: 0,
      issues: [
        {
          code: 'invalid_email',
          count: 1,
          blocking: true,
          examples: [{ row: 2, column: 'Correo', value: 'luis@@x' }],
        },
        {
          code: 'invalid_number',
          count: 1,
          blocking: true,
          examples: [{ row: 2, column: 'Región', value: 'norte' }],
        },
      ],
    };
    await sql`INSERT INTO sample_imports (id, tenant_id, project_id, file_name, size, sha256, headers, mapping, status, report)
      VALUES (${imp}, ${tenant.id}, ${project}, 's.csv', 1, 'x', ${json(['id', 'Nombre', 'Correo', 'Región'])},
        ${json(mapping)}, 'committed', ${json(report)})`.execute(t.owner);
    const unit = randomUUID();
    await sql`INSERT INTO frame_units (id, tenant_id, project_id, external_id, sample, sample_pii, contacts, import_id, case_id)
      VALUES (${unit}, ${tenant.id}, ${project}, ${'U' + unit.slice(-6)}, ${json({ first_name: 'Luis', region: 1 })},
        'v1.sealed', ${json([{ type: 'phone', value: '+51987654321' }])}, ${imp}, ${caseId})`.execute(
      t.owner,
    );
    await sql`UPDATE cases SET import_id = ${imp}, frame_unit_id = ${unit} WHERE id = ${caseId}`.execute(
      t.owner,
    );
    const second = randomUUID();
    await sql`INSERT INTO entry_mismatches (id, tenant_id, project_id, case_id, first_interview_id, second_interview_id, variable, first_value, second_value)
      VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${caseId}, ${iv}, ${second}, 'PHONE', ${json('987654321')}, ${json('987654320')}),
             (${randomUUID()}, ${tenant.id}, ${project}, ${caseId}, ${iv}, ${second}, 'AGE', ${json(40)}, ${json(41)})`.execute(
      t.owner,
    );
    const batch = randomUUID();
    const form = randomUUID();
    await sql`INSERT INTO papi_scan_batches (id, tenant_id, project_id, file_name, status)
      VALUES (${batch}, ${tenant.id}, ${project}, 'scan.pdf', 'done')`.execute(t.owner);
    await sql`INSERT INTO papi_scan_forms (id, tenant_id, project_id, batch_id, case_id, questionnaire_version_id, lang, status, pages_expected)
      VALUES (${form}, ${tenant.id}, ${project}, ${batch}, ${caseId}, ${version}, 'es', 'done', 1)`.execute(
      t.owner,
    );
    await sql`INSERT INTO papi_scan_pages (id, tenant_id, batch_id, form_id, page_no, width, height, image)
      VALUES (${randomUUID()}, ${tenant.id}, ${batch}, ${form}, 1, 10, 10, ${Buffer.from('png')})`.execute(
      t.owner,
    );
    await t.app.get(BiService).refresh(true);
    const inModel = () =>
      rows(sql`SELECT 1 AS x FROM bi.fact_respuesta WHERE envio_id = ${iv} AND variable = 'PHONE'`);
    expect(await inModel()).toHaveLength(1);

    const erase = await pm.agent
      .post(`${base()}/cases/${caseId}/erase`)
      .set('x-csrf-token', pm.csrf)
      .send({ note: 'Solicitud ARCO 2026-18' });
    expect(erase.status, JSON.stringify(erase.body)).toBe(200);

    const [u] = await rows(
      sql`SELECT sample, sample_pii, contacts FROM frame_units WHERE id = ${unit}`,
    );
    expect(JSON.parse(u!.sample as string)).toEqual({ region: 1 });
    expect(u!.sample_pii).toBeNull();
    expect(JSON.parse(u!.contacts as string)).toEqual([]);
    const [r] = await rows(sql`SELECT report FROM sample_imports WHERE id = ${imp}`);
    const examples = (JSON.parse(r!.report as string) as typeof report).issues.map(
      (i) => i.examples[0]!.value,
    );
    expect(examples).toEqual(['', 'norte']);
    const ms = await rows(sql`SELECT variable, first_value, second_value FROM entry_mismatches
      WHERE case_id = ${caseId} ORDER BY variable`);
    const val = (v: unknown) => (v === null ? null : JSON.parse(v as string));
    expect(ms.map((m) => [m.variable, val(m.first_value), val(m.second_value)])).toEqual([
      ['AGE', 40, 41],
      ['PHONE', null, null],
    ]);
    expect(
      await rows(sql`SELECT 1 AS x FROM papi_scan_pages WHERE form_id = ${form}`),
    ).toHaveLength(0);
    // The analysis model sees the change and is refreshed.
    await t.app.get(JobsService).drain();
    expect(await inModel()).toHaveLength(0);
  });

  it('removes personal data after the retention period, and only then', async () => {
    const old = await interviewed();
    const recent = await interviewed();
    await sql`UPDATE cases SET updated_at = DATEADD(day, -40, SYSDATETIMEOFFSET()) WHERE id = ${old.caseId}`.execute(
      t.owner,
    );
    await sql`UPDATE projects SET settings = ${json({ retention: { anonymiseAfterDays: 30 } })} WHERE id = ${project}`.execute(
      t.owner,
    );
    expect(await privacy.retentionAll()).toBeGreaterThanOrEqual(1);
    const found = await rows(
      sql`SELECT id, anonymised_at FROM cases WHERE id IN (${old.caseId}, ${recent.caseId})`,
    );
    const by = Object.fromEntries(
      found.map((x) => [(x.id as string).toLowerCase(), x.anonymised_at]),
    );
    expect(by[old.caseId]).not.toBeNull();
    expect(by[recent.caseId]).toBeNull();
    const [a] = await rows(
      sql`SELECT actor_user_id, details FROM audit_log WHERE target_id = ${old.caseId} AND action = 'case.anonymised'`,
    );
    expect(a!.actor_user_id).toBeNull();
    expect(JSON.parse(a!.details as string)).toMatchObject({ reason: 'retention' });
  });
});
