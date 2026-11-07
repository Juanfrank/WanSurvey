import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, newCase, newContact, post, setSettings } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
} from './harness.js';

const definition = {
  id: 'LB',
  title: { es: 'LB' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: { es: '¿Edad?' } },
      ],
    },
  ],
};

/** Nothing is called, started or downloaded to a device until the lawful basis is declared. */
describe.skipIf(!configured)('SQL Server: lawful basis for calls and visits', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('refuses a call, a face-to-face start and a checkout until the basis for that channel is declared', async () => {
    const project = await createProject(t.owner, tenant.id);
    const qid = await createQuestionnaire(t.owner, tenant.id, project, {
      definition,
      publish: true,
    });
    await sql`UPDATE projects SET timezone = 'America/Lima' WHERE id = ${project}`.execute(t.owner);
    const user = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    const me = await login(t, user, tenant.slug);
    const caseId = await newCase(t.owner, tenant.id, project, { holder: user.id, sample: {} });
    await newContact(t.owner, tenant.id, caseId);
    const base = {
      assignmentMode: 'assigned',
      cati: { callingHours: { from: '00:00', to: '00:00' }, maxAttempts: 3 },
    };

    // Declared for nothing.
    await setSettings(t.owner, project, { ...base, contactBasis: { phone: null, visit: null } });
    const call = await post(me, `/projects/${project}/cati/next`, { questionnaireId: qid });
    expect(call.status).toBe(409);
    expect(call.body.code).toBe('NO_LAWFUL_BASIS');
    const start = await post(me, `/projects/${project}/interviews`, {
      id: crypto.randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: 'dev-lawful-1',
    });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('NO_LAWFUL_BASIS');
    const checkout = await post(me, `/projects/${project}/capi/checkout`, {
      deviceId: 'dev-lawful-1',
      caseIds: [caseId],
    });
    expect(checkout.status).toBe(409);
    expect(checkout.body.code).toBe('NO_LAWFUL_BASIS');

    // Only the telephone: calls go, visits still do not.
    await setSettings(t.owner, project, {
      ...base,
      contactBasis: { phone: 'public_task', visit: null },
    });
    const call2 = await post(me, `/projects/${project}/cati/next`, { questionnaireId: qid });
    expect([200, 204]).toContain(call2.status);
    const checkout2 = await post(me, `/projects/${project}/capi/checkout`, {
      deviceId: 'dev-lawful-1',
      caseIds: [caseId],
    });
    expect(checkout2.status).toBe(409);
    expect(checkout2.body.code).toBe('NO_LAWFUL_BASIS');
  });
});
