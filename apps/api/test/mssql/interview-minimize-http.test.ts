import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, get, newCase, newContact, post, setSettings } from './fixtures.js';
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
/** The questionnaire shows the first name and the region; nothing else of the case. */
const definition = {
  id: 'MINIMAL',
  title: es('Mínimo'),
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [
        { kind: 'static', id: 'HELLO', text: es('¿Hablo con {{case.first_name}}?') },
        {
          kind: 'question',
          id: 'REGION',
          name: 'REGION',
          type: 'numeric',
          text: es('Región'),
          prefill: 'case.region',
        },
      ],
    },
  ],
  scripts: [
    {
      id: 'INTRO',
      anchor: { at: 'start' },
      modes: ['CATI'],
      body: es('Buenos días, ¿está {{case.first_name}}?'),
    },
  ],
};

const SAMPLE = {
  first_name: 'Rosa',
  last_name: 'Quispe',
  address: 'Jr. Las Flores 123',
  dni: '40404040',
  region: 2,
};

/**
 * Data minimisation in interviews (CATI, CAPI): personal sample fields reach the interviewer's
 * screen and device only where the questionnaire uses them, or, face to face, when the project
 * marks them as needed to reach the household. Contacts never travel with the interview; a call
 * shows its numbers masked.
 */
describe.skipIf(!configured)('SQL Server: personal data minimised in interviews', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let iUser: TestUser;
  let me: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    await setSettings(t.owner, project, { cati: { callingHours: { from: '00:00', to: '00:00' } } });
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    for (const [name, pii] of [
      ['first_name', 1],
      ['last_name', 1],
      ['address', 1],
      ['dni', 1],
      ['region', 0],
    ] as const)
      await sql`INSERT INTO sample_fields (id, tenant_id, project_id, name, type, pii)
                VALUES (${randomUUID()}, ${tenant.id}, ${project}, ${name}, 'text', ${pii})`.execute(
        t.owner,
      );
    iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t, iUser, tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  const mkCase = async () => {
    const id = await newCase(t.owner, tenant.id, project, { holder: iUser.id, sample: SAMPLE });
    await newContact(t.owner, tenant.id, id, { value: '+51987654321' });
    await newContact(t.owner, tenant.id, id, {
      type: 'address',
      value: 'Av. Sol 456',
      label: 'Casa',
    });
    return id;
  };
  const leaks = (body: unknown) =>
    ['Quispe', '40404040', 'Las Flores', '987654321', 'Av. Sol'].filter((s) =>
      JSON.stringify(body).includes(s),
    );

  it('an interview gets only the personal fields its questionnaire shows, and no contacts', async () => {
    const caseId = await mkCase();
    const res = await post(me, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: 'tablet-min',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ctx = res.body.context;
    expect(ctx.case).toEqual({ first_name: 'Rosa', region: 2 });
    expect(ctx.personal).toEqual(['first_name']);
    expect(ctx.fieldwork).toEqual([]);
    expect(ctx.contacts).toBeUndefined();
    expect(ctx.addresses).toBeUndefined();
    expect(leaks(res.body)).toEqual([]);
    // What is kept with the interview is minimised too.
    const [stored] = (
      (await sql<{
        context: string;
      }>`SELECT context FROM interviews WHERE id = ${res.body.interview.id}`.execute(t.owner)) as {
        rows: { context: string }[];
      }
    ).rows;
    expect(leaks(stored!.context)).toEqual([]);
  });

  it('face to face, what the project marks as needed to reach the household goes too, also offline', async () => {
    await setSettings(t.owner, project, {
      cati: { callingHours: { from: '00:00', to: '00:00' } },
      capi: { fieldworkFields: ['address'], fieldworkAddress: true },
    });
    try {
      const caseId = await mkCase();
      const co = await post(me, `/projects/${project}/capi/checkout`, {
        deviceId: 'tablet-min',
        caseIds: [caseId],
      });
      expect(co.status, JSON.stringify(co.body)).toBe(200);
      const ctx = co.body.cases[0].context;
      expect(ctx.case).toEqual({ first_name: 'Rosa', address: 'Jr. Las Flores 123', region: 2 });
      expect(ctx.personal).toEqual(['first_name']);
      expect(ctx.fieldwork).toEqual(['address']);
      expect(ctx.addresses).toEqual([{ value: 'Av. Sol 456', label: 'Casa' }]);
      // Never the fields nobody needs, nor the phone.
      const text = JSON.stringify(co.body);
      for (const s of ['Quispe', '40404040', '987654321']) expect(text).not.toContain(s);
    } finally {
      await setSettings(t.owner, project, {
        cati: { callingHours: { from: '00:00', to: '00:00' } },
      });
    }
  });

  it('a call shows the non-personal fields, pipes the scripts and masks the number', async () => {
    await mkCase();
    const served = await post(me, `/projects/${project}/cati/next`, { questionnaireId: qid });
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    expect(served.body.case.sample).toEqual({ region: 2 });
    expect(served.body.scripts.intro).toEqual([{ id: 'INTRO', text: 'Buenos días, ¿está Rosa?' }]);
    expect(served.body.phones).toEqual([
      expect.objectContaining({ masked: '••4321', dial: 'tel:+51987654321' }),
    ]);
    // The dial link is the only place the number is; nothing else personal goes.
    const { phones: _phones, ...rest } = served.body as { phones: unknown };
    expect(leaks(rest)).toEqual([]);
    await post(me, `/cati/attempts/${served.body.attempt.id as string}/release`);
  });

  it('an interview started before minimisation is sent minimised', async () => {
    const caseId = await newCase(t.owner, tenant.id, project, {
      holder: iUser.id,
      sample: SAMPLE,
    });
    const start = await post(me, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'CATI',
      deviceId: 'phone-min',
    });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const id = start.body.interview.id as string;
    // As an older interview kept it: every field and every contact.
    await sql`UPDATE interviews SET context = ${JSON.stringify({
      externalId: 'OLD',
      case: SAMPLE,
      contacts: [{ type: 'phone', value: '+51987654321', label: null }],
    })} WHERE id = ${id}`.execute(t.owner);
    const res = await get(me, `/interviews/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.context).toMatchObject({
      externalId: 'OLD',
      case: { first_name: 'Rosa', region: 2 },
      personal: ['first_name'],
    });
    expect(leaks(res.body)).toEqual([]);
  });
});
