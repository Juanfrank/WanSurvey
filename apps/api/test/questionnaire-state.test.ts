import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config.js';
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

/** Disabling a questionnaire stops new fills in every mode; completing it closes it for good. */
describe('questionnaire state', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let q1: string;
  let q2: string;
  let pm: Session;
  let interviewer: TestUser;
  let iv: Session;

  beforeAll(async () => {
    process.env.PUBLIC_SURVEY_URL = 'http://survey.test';
    resetConfigCache();
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    q1 = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    q2 = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    interviewer = await createUser(t.admin, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    iv = await login(t.app, interviewer);
  });
  afterAll(() => t.close());

  const base = () => `/api/v1/projects/${project}`;
  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);
  const setState = (s: Session, qid: string, body: object) =>
    post(s, `${base()}/questionnaires/${qid}/state`, body);
  async function newCase(qid: string, status = 'assigned') {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, status, assigned_to)
      values (${id}, ${tenant.id}, ${project}, ${qid}, ${'S' + id.slice(-6)}, ${t.admin.json({})},
              ${status}, ${status === 'fresh' ? null : interviewer.id})`;
    return id;
  }
  const start = (caseId: string, qid: string, id = uuidv7()) =>
    post(iv, `${base()}/interviews`, {
      id,
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: 'dev-state-0001',
    });
  const http = () => request(t.app.getHttpServer());

  it('disabling stops new fills in every mode, keeps what was started, and can be undone', async () => {
    const started = await newCase(q1);
    const startedId = uuidv7();
    expect((await start(started, q1, startedId)).status).toBe(200);
    const link = await pm.agent
      .put(`${base()}/open-link`)
      .set('x-csrf-token', pm.csrf)
      .send({ active: true, questionnaireId: q1 });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const slug = link.body.link.slug as string;

    // Only those who publish questionnaires change their state.
    expect((await setState(iv, q1, { state: 'disabled' })).status).toBe(403);
    const off = await setState(pm, q1, { state: 'disabled' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ state: 'disabled', successorId: null });

    const other = await newCase(q1);
    const refused = await start(other, q1);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('QUESTIONNAIRE_DISABLED');
    // What was started goes on.
    expect((await start(started, q1, startedId)).status).toBe(200);
    const web = await http().post(`/api/v1/public/o/${slug}/start`);
    expect(web.status).toBe(410);
    expect(web.body.code).toBe('QUESTIONNAIRE_DISABLED');
    const list = await pm.agent.get(`${base()}/questionnaires`).expect(200);
    expect(list.body.find((q: { id: string }) => q.id === q1)).toMatchObject({
      state: 'disabled',
    });

    await setState(pm, q1, { state: 'active' }).expect(200);
    expect((await start(other, q1)).status).toBe(200);
    expect((await http().post(`/api/v1/public/o/${slug}/start`)).status).toBe(200);
  });

  it('completing closes the pending cases, and the web link goes on with the continuation', async () => {
    const pending = await newCase(q1, 'fresh');
    // The continuation must be another active questionnaire of the project.
    expect((await setState(pm, q1, { state: 'completed', successorId: q1 })).body.code).toBe(
      'BAD_SUCCESSOR',
    );
    expect((await setState(pm, q1, { state: 'completed', successorId: uuidv7() })).body.code).toBe(
      'BAD_SUCCESSOR',
    );

    const done = await setState(pm, q1, { state: 'completed', successorId: q2 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ state: 'completed', successorId: q2 });
    expect(done.body.casesClosed).toBeGreaterThanOrEqual(1);
    const [c] = await t.admin`select status, disposition from cases where id = ${pending}`;
    expect(c).toMatchObject({ status: 'finalised', disposition: 'FIELDWORK_CLOSED' });
    // Interviews in progress were left alone.
    const inProgress =
      await t.admin`select count(*)::int as n from cases where questionnaire_id = ${q1} and status = 'in_progress'`;
    expect(inProgress[0]!.n).toBeGreaterThan(0);

    // The project's open link now starts the continuation.
    const link = (await pm.agent.get(`${base()}/open-link`).expect(200)).body.link;
    const s = await http().post(`/api/v1/public/o/${link.slug}/start`).expect(200);
    const opened = await http().get(`/api/v1/public/s/${s.body.token}?device=anon-state-1`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const [inv] =
      await t.admin`select questionnaire_id from invitations where project_id = ${project} order by queued_at desc limit 1`;
    expect(inv!.questionnaire_id).toBe(q2);

    // A completed questionnaire without continuation: closed for respondents.
    await setState(pm, q1, { state: 'completed' }).expect(200);
    const closed = await http().post(`/api/v1/public/o/${link.slug}/start`);
    expect(closed.status).toBe(410);
    expect(closed.body.code).toBe('QUESTIONNAIRE_COMPLETED');

    const audit =
      await t.admin`select action from audit_log where target_id = ${q1} and action like 'questionnaire.%' order by at`;
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'questionnaire.disabled',
        'questionnaire.enabled',
        'questionnaire.completed',
      ]),
    );
  });
});
