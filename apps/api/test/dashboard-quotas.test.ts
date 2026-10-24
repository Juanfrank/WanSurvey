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
} from './harness.js';

const es = (text: string) => ({ es: text });
const definition = (id: string, quotas: { id: string; when: string }[]) => ({
  id,
  title: es(id),
  defaultLanguage: 'es',
  languages: ['es'],
  quotas: quotas.map((q) => ({ ...q, name: q.id, max: 10 })),
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [
        {
          kind: 'question',
          id: 'WORK',
          name: 'WORK',
          type: 'single',
          text: es('¿Trabaja?'),
          options: [
            { code: 1, label: es('Sí') },
            { code: 2, label: es('No') },
          ],
        },
      ],
    },
  ],
});

describe('live dashboard quotas', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let pm: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
  });
  afterAll(() => t.close());

  async function complete(qid: string, answers: object, sample: object) {
    const [v] =
      await t.admin`select id from questionnaire_versions where questionnaire_id = ${qid}`;
    await t.admin`insert into interviews (id, tenant_id, project_id, questionnaire_version_id, mode,
        status, disposition, language, answers, context, device_id, submitted_at, submissions, ended_at)
      values (${uuidv7()}, ${tenant.id}, ${project}, ${v!.id}, 'CAWI', 'submitted', 'COMPLETE', 'es',
        ${t.admin.json(answers as never)}, ${t.admin.json({ case: sample } as never)}, 'dev-q',
        now(), 1, now())`;
  }

  it('counts each quota over its own questionnaire, with the sample fields', async () => {
    const first = await createQuestionnaire(t.admin, tenant.id, project, {
      publish: true,
      definition: definition('FIRST', [{ id: 'WORKERS', when: 'WORK == 1' }]),
    });
    const second = await createQuestionnaire(t.admin, tenant.id, project, {
      publish: true,
      definition: definition('SECOND', [{ id: 'NORTH', when: 'case.region == 2' }]),
    });
    await complete(first, { WORK: 1 }, { region: 2 });
    await complete(first, { WORK: 1 }, { region: 2 });
    await complete(second, { WORK: 1 }, { region: 2 });
    await complete(second, { WORK: 2 }, { region: 1 });

    const snap = await pm.agent.get(`/api/v1/projects/${project}/live/snapshot`).expect(200);
    const count = (id: string) =>
      (snap.body.quotas as { id: string; count: number }[]).find((q) => q.id === id)?.count;
    // The second questionnaire's worker is not in the first one's cell.
    expect(count('WORKERS')).toBe(2);
    // The first questionnaire's interviews in region 2 are not in the second one's cell.
    expect(count('NORTH')).toBe(1);
  });
});
