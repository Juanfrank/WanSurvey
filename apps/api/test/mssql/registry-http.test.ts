import { createInterview } from '@wansurvey/logic';
import { toCsv } from '@wansurvey/fixtures';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, newCase, newContact, post, setSettings } from './fixtures.js';
import {
  auditActions,
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

const ALL_DAY = { from: '00:00', to: '00:00' };
const definition = {
  id: 'REG',
  title: { es: 'Registro' },
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

/** The people registry on SQL Server (ADR 0002): no-contact list, history, queue, loads and calls. */
describe.skipIf(!configured)('SQL Server: people registry and no contact', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let admin: Session;
  let interviewerUser: TestUser;
  let interviewer: Session;
  let project: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]), tenant.slug);
    project = await createProject(t.owner, tenant.id);
    await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    await setSettings(t.owner, project, {
      assignmentMode: 'assigned',
      cati: { callingHours: ALL_DAY, maxAttempts: 3 },
    });
    interviewerUser = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    interviewer = await login(t, interviewerUser, tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  const reg = (path: string) => `/api/v1/registry${path}`;
  const add = (body: object) =>
    admin.agent.post(reg('/no-contact')).set('x-csrf-token', admin.csrf).send(body);

  it('adds, finds and lifts an entry, normalising the number', async () => {
    expect((await interviewer.agent.get(reg('/no-contact'))).status).toBe(403);
    expect((await add({ value: 'no es un contacto' })).status).toBe(400);
    const res = await add({ value: '+51 987-000-111', reason: 'not_interested', days: 30 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ added: 1, updated: 0 });
    // Adding it again updates the entry and does not repeat it.
    expect((await add({ value: '+51987000111', channels: ['CATI'], days: null })).body).toEqual({
      added: 0,
      updated: 1,
    });
    const list = await admin.agent.get(reg('/no-contact?q=987000'));
    expect(list.body.total).toBe(1);
    expect(list.body.rows[0]).toMatchObject({
      kind: 'phone',
      value: '+51987000111',
      channels: ['CATI'],
      expiresAt: null,
    });
    const look = await admin.agent.get(reg('/lookup?value=%2B51987000111'));
    expect(look.body.noContact).toHaveLength(1);
    expect(
      (
        await admin.agent
          .delete(reg(`/no-contact/${list.body.rows[0].id}`))
          .set('x-csrf-token', admin.csrf)
      ).status,
    ).toBe(200);
    expect((await admin.agent.get(reg('/no-contact?q=987000'))).body.total).toBe(0);
    expect((await admin.agent.get(reg('/no-contact?q=987000&status=lifted'))).body.total).toBe(1);
    expect(await auditActions(t.owner, tenant.id)).toEqual(
      expect.arrayContaining(['registry.no_contact_added', 'registry.no_contact_lifted']),
    );
  });

  it('loads a list of people not to contact and the history, reporting what it cannot read', async () => {
    const res = await admin.agent
      .post(reg('/no-contact/import'))
      .set('x-csrf-token', admin.csrf)
      .send({
        defaultCountryCode: '51',
        rows: [
          { value: '987 000 201', reason: 'no llamar' },
          {
            value: 'ANA@Example.org',
            reason: 'no interesado',
            channels: 'CAWI; CATI',
            until: '31/12/2099',
          },
          { value: 'abc' },
          { value: '987000202', reason: 'otra cosa' },
          { value: '987000203', channels: 'FAX' },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ added: 2, updated: 0, rejected: 3 });
    expect(res.body.examples.map((e: { why: string }) => e.why)).toEqual([
      'contact',
      'reason',
      'channels',
    ]);
    const mail = await admin.agent.get(reg('/lookup?value=ana%40example.org'));
    expect(mail.body.noContact[0]).toMatchObject({
      reason: 'not_interested',
      channels: ['CAWI', 'CATI'],
    });
    expect(mail.body.noContact[0].expiresAt).toMatch(/^2099-12-31/);

    const hist = await admin.agent
      .post(reg('/participations/import'))
      .set('x-csrf-token', admin.csrf)
      .send({
        defaultCountryCode: '51',
        rows: [
          {
            value: '987000301',
            channel: 'cati',
            date: '2021-05-04',
            result: 'COMPLETE',
            project: 'Encuesta 2021',
          },
          { value: '987000302', channel: 'FAX', date: '2021-05-04' },
          { value: '987000303', channel: 'CAWI', date: '04/13/2021' },
        ],
      });
    expect(hist.body).toMatchObject({ loaded: 1, rejected: 2 });
    const look = await admin.agent.get(reg('/lookup?value=%2B51987000301'));
    expect(look.body.participations[0]).toMatchObject({
      channel: 'CATI',
      result: 'COMPLETE',
      projectName: 'Encuesta 2021',
      source: 'history',
    });
  });

  it('keeps people off the call queue for the channels the entry covers', async () => {
    const id = await newCase(t.owner, tenant.id, project, { holder: interviewerUser.id });
    await newContact(t.owner, tenant.id, id, { value: '+51987000401' });
    await add({ value: '+51987000401', channels: ['CAWI'] });
    const served = await post(interviewer, `/projects/${project}/cati/next`);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    await post(interviewer, `/cati/attempts/${served.body.attempt.id}/release`);
    // Now for every channel: not served, whoever asks.
    await add({ value: '+51987000401', channels: null });
    const none = await post(interviewer, `/projects/${project}/cati/next`);
    expect(none.status).toBe(204);
    const list = await admin.agent.get(reg('/no-contact?q=987000401'));
    await admin.agent
      .delete(reg(`/no-contact/${list.body.rows[0].id}`))
      .set('x-csrf-token', admin.csrf);
    expect((await post(interviewer, `/projects/${project}/cati/next`)).status).toBe(200);
  });

  it('turns "do not contact" in a call into entries for every contact of the case', async () => {
    await setSettings(t.owner, project, {
      assignmentMode: 'assigned',
      cati: { callingHours: ALL_DAY, maxAttempts: 3 },
      contactRules: { noContact: { defaultDays: 30 } },
    });
    // Whatever is open is closed first.
    const open = await interviewer.agent.get(`/api/v1/projects/${project}/cati/current`);
    if (open.status === 200)
      await post(interviewer, `/cati/attempts/${open.body.attempt.id}/release`);
    await sql`UPDATE cases SET status = 'withdrawn' WHERE project_id = ${project}`.execute(t.owner);
    const id = await newCase(t.owner, tenant.id, project, { holder: interviewerUser.id });
    await newContact(t.owner, tenant.id, id, { value: '+51987000501' });
    await newContact(t.owner, tenant.id, id, {
      type: 'email',
      value: 'Persona@Example.org',
      label: null,
    });
    const call = await post(interviewer, `/projects/${project}/cati/next`);
    expect(call.status, JSON.stringify(call.body)).toBe(200);
    const out = await post(interviewer, `/cati/attempts/${call.body.attempt.id}/outcome`, {
      outcome: 'do_not_contact',
      note: 'Pidió que no lo llamen',
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toMatchObject({ disposition: 'REFUSAL', final: true });
    const phone = await admin.agent.get(reg('/lookup?value=%2B51987000501'));
    expect(phone.body.noContact[0]).toMatchObject({
      reason: 'do_not_contact',
      source: 'call',
      channels: null,
    });
    // Thirty days, as the project says.
    const days = (new Date(phone.body.noContact[0].expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    // The e-mail is there as the registry keeps it (lower case).
    expect(
      (await admin.agent.get(reg('/lookup?value=persona%40example.org'))).body.noContact,
    ).toHaveLength(1);
  });

  it('leaves out of a load the people on the list or surveyed lately, and says so', async () => {
    await setSettings(t.owner, project, {
      assignmentMode: 'assigned',
      contactRules: { exclusion: { days: 365, channels: ['CATI'] } },
    });
    await add({ value: '+51987000601', channels: null });
    const recent = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await admin.agent
      .post(reg('/participations/import'))
      .set('x-csrf-token', admin.csrf)
      .send({ rows: [{ value: '+51987000602', channel: 'CATI', date: recent }] });
    // A web participation does not count: the project's channels for the rule are CATI only.
    await admin.agent
      .post(reg('/participations/import'))
      .set('x-csrf-token', admin.csrf)
      .send({ rows: [{ value: '+51987000603', channel: 'CAWI', date: recent }] });
    const table = [
      ['id', 'phone'],
      ['1', '+51987000601'],
      ['2', '+51987000602'],
      ['3', '+51987000603'],
      ['4', '+51987000604'],
    ];
    const pm = admin;
    const up = await pm.agent
      .post(`/api/v1/projects/${project}/imports`)
      .set('x-csrf-token', pm.csrf)
      .attach('file', Buffer.from(toCsv(table)), 'lista.csv');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const mapped = await pm.agent
      .put(`/api/v1/projects/${project}/imports/${up.body.id}/mapping`)
      .set('x-csrf-token', pm.csrf)
      .send(up.body.suggested);
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    const codes = Object.fromEntries(
      mapped.body.issues.map((i: { code: string; count: number }) => [i.code, i.count]),
    );
    expect(codes).toMatchObject({ no_contact: 1, recent_participation: 1 });
    expect(mapped.body).toMatchObject({ total: 4, toCreate: 2 });
  });

  it('records a participation when an interview of a case is submitted', async () => {
    const caseId = await newCase(t.owner, tenant.id, project, { holder: interviewerUser.id });
    await newContact(t.owner, tenant.id, caseId, { value: '+51987000701' });
    await newContact(t.owner, tenant.id, caseId, {
      type: 'email',
      value: 'quien@example.org',
      label: null,
    });
    const qid = (
      await sql<{
        id: string;
      }>`SELECT TOP 1 id FROM questionnaires WHERE project_id = ${project}`.execute(t.owner)
    ).rows[0]!.id.toLowerCase();
    const device = 'device-registry';
    const started = await post(interviewer, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: device,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const p = started.body as { interview: { id: string; startedAt: string }; compiled: never };
    const s = createInterview(p.compiled, {
      mode: 'CAPI',
      language: 'es',
      seed: p.interview.id,
      now: () => new Date(p.interview.startedAt),
      context: {},
    });
    s.setAnswer('AGE', 33 as never);
    s.next();
    const ops = s.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date(Date.now() - 30_000).toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    await post(interviewer, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id: p.interview.id, ops, state: s.state(), activeMs: 600_000 }],
    });
    const sub = await post(interviewer, `/interviews/${p.interview.id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path: s.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const look = await admin.agent.get(reg('/lookup?value=%2B51987000701'));
    expect(look.body.participations).toHaveLength(1);
    expect(look.body.participations[0]).toMatchObject({ channel: 'CAPI', source: 'system' });
    expect(
      (await admin.agent.get(reg('/lookup?value=quien%40example.org'))).body.participations,
    ).toHaveLength(1);
  });
});
