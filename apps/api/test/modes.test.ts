import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const definition = (id: string, modes: string[]) => ({
  id,
  title: es(id),
  defaultLanguage: 'es',
  languages: ['es'],
  modes,
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [{ kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: es('¿Edad?') }],
    },
  ],
});

describe('a questionnaire is fielded only in its modes (Q1)', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let phoneOnly: string;
  let paper: string;
  let iUser: TestUser;
  let me: Session;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    phoneOnly = await createQuestionnaire(t.admin, tenant.id, project, {
      definition: definition('PHONE', ['CATI']),
      publish: true,
    });
    paper = await createQuestionnaire(t.admin, tenant.id, project, {
      definition: definition('PAPER', ['PAPI', 'CAPI']),
      publish: true,
    });
    iUser = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t.app, iUser);
    pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  async function newCase() {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
      values (${id}, ${tenant.id}, ${project}, ${'M' + id.slice(-6)}, ${t.admin.json({})}, 'assigned', ${iUser.id})`;
    return id;
  }
  const start = async (questionnaireId: string, mode: string) =>
    post(me, `/projects/${project}/interviews`, {
      id: uuidv7(),
      caseId: await newCase(),
      questionnaireId,
      mode,
      deviceId: 'device-modes-01',
    });

  it('starts interviews in its modes and refuses the others', async () => {
    expect((await start(phoneOnly, 'CATI')).status).toBe(200);
    const capi = await start(phoneOnly, 'CAPI');
    expect(capi.status).toBe(409);
    expect(capi.body).toMatchObject({ code: 'MODE_NOT_IN_QUESTIONNAIRE', mode: 'CAPI' });
  });

  it('refuses web waves for a questionnaire not fielded on the web', async () => {
    const wave = await post(pm, `/projects/${project}/waves`, {
      name: 'Ola',
      questionnaireId: phoneOnly,
      reminderDays: [],
    });
    expect(wave.body.code).toBe('MODE_NOT_IN_QUESTIONNAIRE');
  });

  it('prints paper forms only for questionnaires fielded on paper', async () => {
    const forms = await pm.agent.get(`/api/v1/projects/${project}/papi/forms`).expect(200);
    expect(forms.body.questionnaire.id).toBe(paper);
    expect(
      (await pm.agent.get(`/api/v1/projects/${project}/papi/forms?questionnaireId=${phoneOnly}`))
        .status,
    ).toBe(404);
  });
});
