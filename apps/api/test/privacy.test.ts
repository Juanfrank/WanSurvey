import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { PrivacyService, stripKeys } from '../src/privacy/privacy.service.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
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

describe('stripKeys', () => {
  it('removes personal variables at any depth and in answer keys', () => {
    expect(
      stripKeys(
        {
          AGE: 3,
          PHONE: '1',
          HH: [{ PHONE: '2', NAME: 'x' }],
          stash: { 'HH[1].PHONE': '3', 'HH[1].NAME': 'y' },
        },
        new Set(['PHONE']),
      ),
    ).toEqual({ AGE: 3, HH: [{ NAME: 'x' }], stash: { 'HH[1].NAME': 'y' } });
  });
});

describe('personal data: sealing, retention and data subject requests', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let version: string;
  let pm: Session;
  let me: Session;
  let iUser: TestUser;
  let privacy: PrivacyService;

  beforeAll(async () => {
    t = await bootstrap();
    privacy = t.app.get(PrivacyService);
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    const qid = await createQuestionnaire(t.admin, tenant.id, project, {
      definition,
      publish: true,
    });
    [{ id: version }] =
      (await t.admin`select id from questionnaire_versions where questionnaire_id = ${qid}`) as unknown as [
        { id: string },
      ];
    for (const [name, pii] of [
      ['first_name', true],
      ['last_name', true],
      ['region', false],
    ] as const)
      await t.admin`insert into sample_fields (id, tenant_id, project_id, name, type, pii)
        values (${uuidv7()}, ${tenant.id}, ${project}, ${name}, 'text', ${pii})`;
    pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
    iUser = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t.app, iUser);
  });
  afterAll(() => t.close());

  const base = () => `/api/v1/projects/${project}`;
  async function newCase(sample: Record<string, unknown>, status = 'assigned') {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
      values (${id}, ${tenant.id}, ${project}, ${'P' + id.slice(-6)}, ${t.admin.json(sample as never)}, ${status}, ${iUser.id})`;
    return id;
  }
  const seal = () =>
    t.app.get(Database).withTenant(tenant.id, (tx) => privacy.sealProject(tx, tenant.id, project));

  it('seals personal sample fields, still shown on reveal and found by name', async () => {
    const id = await newCase({ first_name: 'Rosa María', last_name: 'Quispe', region: 2 });
    expect(await seal()).toBe(1);
    const [row] =
      await t.admin`select sample, sample_pii, sample_pii_index from cases where id = ${id}`;
    expect(row!.sample).toEqual({ region: 2 });
    expect(row!.sample_pii).toMatch(/^v1\./);
    expect(row!.sample_pii).not.toContain('Rosa');
    expect(row!.sample_pii_index).toHaveLength(3);
    expect(await seal()).toBe(0);

    const shown = await pm.agent.get(`${base()}/cases/${id}`).query({ reveal: 'pii' }).expect(200);
    expect(shown.body.sample).toEqual({ first_name: 'Rosa María', last_name: 'Quispe', region: 2 });
    const masked = await pm.agent.get(`${base()}/cases/${id}`).expect(200);
    expect(masked.body.sample.first_name).not.toBe('Rosa María');

    // Whole words of sealed fields, accents and case ignored.
    const found = await pm.agent.get(`${base()}/cases`).query({ q: 'maria quispe' }).expect(200);
    expect(found.body.rows.map((r: { id: string }) => r.id)).toEqual([id]);
    const none = await pm.agent.get(`${base()}/cases`).query({ q: 'ros' }).expect(200);
    expect(none.body.rows).toEqual([]);

    // Edits keep personal fields sealed.
    await pm.agent
      .patch(`${base()}/cases/${id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ sample: { first_name: 'Ana', region: 3 } })
      .expect(200);
    const [after] = await t.admin`select sample, sample_pii from cases where id = ${id}`;
    expect(after!.sample).toEqual({ region: 3 });
    const again = await pm.agent.get(`${base()}/cases/${id}`).query({ reveal: 'pii' });
    expect(again.body.sample).toMatchObject({ first_name: 'Ana', last_name: 'Quispe' });
  });

  async function interviewed() {
    const caseId = await newCase({ first_name: 'Luis', region: 1 }, 'finalised');
    await seal();
    await t.admin`insert into contacts (id, tenant_id, case_id, type, value)
      values (${uuidv7()}, ${tenant.id}, ${caseId}, 'phone', '+51987654321')`;
    const iv = uuidv7();
    const answers = { AGE: 40, PHONE: '987654321' };
    await t.admin`insert into interviews (id, tenant_id, project_id, case_id, questionnaire_version_id, mode,
        interviewer_id, status, disposition, language, answers, state, context, device_id, submitted_at)
      values (${iv}, ${tenant.id}, ${project}, ${caseId}, ${version}, 'CAPI', ${iUser.id}, 'submitted', 'COMPLETE', 'es',
        ${t.admin.json(answers)}, ${t.admin.json({ answers, stash: {} })}, ${t.admin.json({ case: { first_name: 'Luis' } })},
        'dev-p', now())`;
    await t.admin`insert into interview_answer_events (id, tenant_id, interview_id, device_id, seq, variable, old_value, new_value, at, source)
      values (${uuidv7()}, ${tenant.id}, ${iv}, 'dev-p', 1, 'PHONE', null, ${t.admin.json('987654321')}, now(), 'interviewer'),
             (${uuidv7()}, ${tenant.id}, ${iv}, 'dev-p', 2, 'AGE', null, ${t.admin.json(40)}, now(), 'interviewer')`;
    await t.admin`insert into interview_paradata (id, tenant_id, interview_id, device_id, seq, type, at, payload)
      values (${uuidv7()}, ${tenant.id}, ${iv}, 'dev-p', 1, 'note_added', now(), ${t.admin.json({ key: 'AGE', text: 'Vive con Luis' })})`;
    return { caseId, iv };
  }

  it("answers a data subject's access request, then erases what is personal", async () => {
    const { caseId, iv } = await interviewed();
    expect((await me.agent.get(`${base()}/cases/${caseId}/subject-data`)).status).toBe(403);
    const data = await pm.agent.get(`${base()}/cases/${caseId}/subject-data`).expect(200);
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
      .send({ note: 'Solicitud ARCO 2026-17' })
      .expect(200);
    expect(erased.body).toEqual({ interviews: 1, contacts: 1 });

    const [c] =
      await t.admin`select sample, sample_pii, anonymised_at from cases where id = ${caseId}`;
    expect(c).toMatchObject({ sample: { region: 1 }, sample_pii: null });
    expect(c!.anonymised_at).not.toBeNull();
    const [i] = await t.admin`select answers, state, context from interviews where id = ${iv}`;
    expect(i).toMatchObject({ answers: { AGE: 40 }, state: { answers: { AGE: 40 } }, context: {} });
    const events =
      await t.admin`select variable, new_value from interview_answer_events where interview_id = ${iv} order by seq`;
    expect(events.map((e) => [e.variable, e.new_value])).toEqual([
      ['PHONE', null],
      ['AGE', 40],
    ]);
    const [note] = await t.admin`select payload from interview_paradata where interview_id = ${iv}`;
    expect(note!.payload).toEqual({ key: 'AGE' });
    expect(await t.admin`select 1 from contacts where case_id = ${caseId}`).toHaveLength(0);
    const audit =
      await t.admin`select action, details from audit_log where target_id = ${caseId} order by at`;
    expect(audit.map((a) => a.action)).toEqual(['case.subject_exported', 'case.anonymised']);
    expect(audit[1]!.details).toMatchObject({ reason: 'request', note: 'Solicitud ARCO 2026-17' });
  });

  it('removes personal data after the retention period, and only then', async () => {
    const old = await interviewed();
    const recent = await interviewed();
    await t.admin`update cases set updated_at = now() - interval '40 days' where id = ${old.caseId}`;
    await t.admin`update projects set settings = ${t.admin.json({ retention: { anonymiseAfterDays: 30 } })} where id = ${project}`;
    expect(await privacy.retentionAll()).toBeGreaterThanOrEqual(1);
    const rows =
      await t.admin`select id, anonymised_at from cases where id in ${t.admin([old.caseId, recent.caseId])}`;
    const by = Object.fromEntries(rows.map((r) => [r.id, r.anonymised_at]));
    expect(by[old.caseId]).not.toBeNull();
    expect(by[recent.caseId]).toBeNull();
    const [a] =
      await t.admin`select actor_user_id, details from audit_log where target_id = ${old.caseId} and action = 'case.anonymised'`;
    expect(a).toMatchObject({ actor_user_id: null, details: { reason: 'retention' } });
  });
});
