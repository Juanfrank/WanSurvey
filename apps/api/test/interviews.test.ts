import {
  createInterview,
  type CompiledQuestionnaire,
  type InterviewSession,
} from '@wansurvey/logic';
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

/** Three questions: a No on WORK ends the interview; NAME is personal. */
const definition = {
  id: 'RUNTIME',
  title: { en: 'Runtime' },
  defaultLanguage: 'en',
  languages: ['en'],
  sections: [
    {
      id: 'S',
      title: { en: 'S' },
      items: [
        {
          kind: 'question',
          id: 'WORK',
          name: 'WORK',
          type: 'single',
          text: { en: 'Work?' },
          options: [
            { code: 1, label: { en: 'Yes' } },
            { code: 2, label: { en: 'No' } },
          ],
          skips: [{ when: 'WORK == 2', to: 'END' }],
        },
        { kind: 'question', id: 'HOURS', name: 'HOURS', type: 'numeric', text: { en: 'Hours?' } },
        {
          kind: 'question',
          id: 'NAME',
          name: 'NAME',
          type: 'text',
          personal: true,
          text: { en: 'Name of {{case.city}}?' },
        },
      ],
    },
  ],
};

interface Started {
  interview: { id: string; startedAt: string; mode: string; language: string };
  context: { case: Record<string, unknown>; externalId: string };
  compiled: CompiledQuestionnaire;
  lastSeq: number;
}

describe('interview runtime', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let interviewer: TestUser;
  let me: Session;
  let other: Session;
  let supervisor: Session;
  const device = 'device-aaaa-1111';

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { definition, publish: true });
    interviewer = await createUser(t.admin, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    me = await login(t.app, interviewer);
    other = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]));
    supervisor = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'supervisor' }]));
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  async function newCase(holder: string | null) {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
      values (${id}, ${tenant.id}, ${project}, ${'R' + id.slice(-6)}, ${t.admin.json({ city: 'Lima' })},
              ${holder ? 'assigned' : 'fresh'}, ${holder})`;
    return id;
  }
  function session(s: Started): InterviewSession {
    return createInterview(s.compiled, {
      mode: 'CAPI',
      language: s.interview.language,
      seed: s.interview.id,
      now: () => new Date(s.interview.startedAt),
      context: { case: s.context.case },
    });
  }
  /** The session's change events as numbered ops, the way the web client sends them. */
  function ops(sess: InterviewSession, from: number) {
    return sess.drainEvents().map((e, i) => ({
      seq: from + i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
  }

  it('starts once per case, binds the version, and moves the case to in progress', async () => {
    const caseId = await newCase(interviewer.id);
    const id = uuidv7();
    const body = { id, caseId, questionnaireId: qid, mode: 'CAPI', deviceId: device };
    const a = await post(me, `/projects/${project}/interviews`, body);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({
      interview: { id, status: 'in_progress', version: 1, language: 'en' },
      context: { case: { city: 'Lima' } },
      lastSeq: 0,
    });
    expect(a.body.compiled.hash).toEqual(expect.any(String));
    // Again (a retry), or with another id: the same interview comes back.
    expect((await post(me, `/projects/${project}/interviews`, body)).body.interview.id).toBe(id);
    expect(
      (await post(me, `/projects/${project}/interviews`, { ...body, id: uuidv7() })).body.interview
        .id,
    ).toBe(id);
    const [c] = await t.admin`select status from cases where id = ${caseId}`;
    expect(c!.status).toBe('in_progress');
    // Someone who does not hold the case cannot start it; a supervisor does not conduct.
    expect(
      (await post(other, `/projects/${project}/interviews`, { ...body, id: uuidv7() })).status,
    ).toBe(404);
    expect((await post(supervisor, `/projects/${project}/interviews`, body)).status).toBe(403);
  });

  it('syncs changes idempotently and submits after the server re-checks the path', async () => {
    const caseId = await newCase(interviewer.id);
    const id = uuidv7();
    const started = (
      await post(me, `/projects/${project}/interviews`, {
        id,
        caseId,
        questionnaireId: qid,
        mode: 'CAPI',
        deviceId: device,
      })
    ).body as Started;
    const s = session(started);
    s.setAnswer('WORK', 1);
    s.next();
    s.setAnswer('HOURS', 40);
    s.next();
    const first = ops(s, 0);
    expect(first).toHaveLength(2);
    const batch = {
      deviceId: device,
      interviews: [{ id, ops: first, state: s.state(), position: s.currentKey() }],
    };
    const r1 = await post(me, '/interviews/sync', batch);
    expect(r1.body).toMatchObject({ acks: { [id]: 2 }, errors: {} });
    // The same batch again changes nothing.
    expect((await post(me, '/interviews/sync', batch)).body.acks[id]).toBe(2);
    const stored =
      await t.admin`select count(*)::int as n from interview_answer_events where interview_id = ${id}`;
    expect(stored[0]!.n).toBe(2);

    // A gap: changes 4 and 5 without 3 are not taken, and neither is the snapshot.
    s.setAnswer('NAME', 'Ana');
    s.next();
    const later = ops(s, 2);
    const gap = await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [
        {
          id,
          ops: [
            { ...later[0]!, seq: 4 },
            { kind: 'paradata', seq: 5, type: 'pause', at: new Date().toISOString(), payload: {} },
          ],
          state: s.state(),
        },
      ],
    });
    expect(gap.body.acks[id]).toBe(2);
    // Out of order within a batch is fine.
    const para = {
      kind: 'paradata' as const,
      seq: 4,
      type: 'leave_question' as const,
      at: new Date().toISOString(),
      monotonicMs: 1234,
      payload: { key: 'NAME' },
    };
    const ok = await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [
        {
          id,
          ops: [para, later[0]!],
          state: s.state(),
          position: s.currentKey(),
          activeMs: 5000,
          totalMs: 6000,
        },
      ],
    });
    expect(ok.body.acks[id]).toBe(4);
    const [row] = await t.admin`select answers, active_ms from interviews where id = ${id}`;
    expect(row!.answers).toMatchObject({ WORK: 1, HOURS: 40, NAME: 'Ana' });
    expect(row!.active_ms).toBe(5000);

    // Another device may not write it; only its holder may.
    expect(
      (await post(me, '/interviews/sync', { ...batch, deviceId: 'device-bbbb-2222' })).body.errors[
        id
      ],
    ).toBe('NOT_THIS_DEVICE');
    expect((await post(other, '/interviews/sync', batch)).body.errors[id]).toBe('NOT_FOUND');

    // Submit: everything must be synced, and the path must match the server's.
    const path = s.pathKeys();
    expect(
      (await post(me, `/interviews/${id}/submit`, { deviceId: device, seq: 9, path })).body.code,
    ).toBe('NOT_SYNCED');
    const bad = await post(me, `/interviews/${id}/submit`, {
      deviceId: device,
      seq: 4,
      path: ['WORK'],
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'PATH_MISMATCH', missing: ['HOURS', 'NAME'] });
    const done = await post(me, `/interviews/${id}/submit`, { deviceId: device, seq: 4, path });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ status: 'submitted', disposition: 'COMPLETE' });
    expect(
      (await post(me, `/interviews/${id}/submit`, { deviceId: device, seq: 4, path })).body.code,
    ).toBe('SUBMITTED');
    const [c] = await t.admin`select status, disposition from cases where id = ${caseId}`;
    expect(c).toEqual({ status: 'finalised', disposition: 'COMPLETE' });
    // A finished case cannot be started again.
    expect(
      (
        await post(me, `/projects/${project}/interviews`, {
          id: uuidv7(),
          caseId,
          questionnaireId: qid,
          mode: 'CAPI',
          deviceId: device,
        })
      ).body.code,
    ).toBe('CASE_CLOSED');

    // The answer history, oldest first, with who and why.
    const h = await supervisor.agent.get(`/api/v1/projects/${project}/cases/${caseId}/interviews`);
    expect(h.body).toHaveLength(1);
    expect(h.body[0]).toMatchObject({
      status: 'submitted',
      version: 1,
      disposition: 'COMPLETE',
      activeMs: 5000,
    });
    expect(
      h.body[0].events.map((e: { variable: string; newValue: unknown }) => [
        e.variable,
        e.newValue,
      ]),
    ).toEqual([
      ['WORK', 1],
      ['HOURS', 40],
      ['NAME', 'Ana'],
    ]);
    expect(h.body[0].events[0]).toMatchObject({ source: 'interviewer', by: expect.any(String) });
    await expect(
      t.admin`update interview_answer_events set variable = 'x' where interview_id = ${id}`,
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to submit an unfinished interview', async () => {
    const caseId = await newCase(interviewer.id);
    const id = uuidv7();
    await post(me, `/projects/${project}/interviews`, {
      id,
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: device,
    });
    const r = await post(me, `/interviews/${id}/submit`, {
      deviceId: device,
      seq: 0,
      path: ['WORK'],
    });
    expect(r.body.code).toBe('NOT_COMPLETE');
    // Resuming returns the stored state.
    expect((await me.agent.get(`/api/v1/interviews/${id}`)).body.interview.id).toBe(id);
    expect((await other.agent.get(`/api/v1/interviews/${id}`)).status).toBe(404);
  });

  it('in pool mode, starting on a free case takes it; no published version is refused', async () => {
    await t.admin`update projects set settings = ${t.admin.json({ assignmentMode: 'pool' })} where id = ${project}`;
    const caseId = await newCase(null);
    const r = await post(other, `/projects/${project}/interviews`, {
      id: uuidv7(),
      caseId,
      questionnaireId: qid,
      mode: 'CATI',
      deviceId: device,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [c] = await t.admin`select assigned_to, status from cases where id = ${caseId}`;
    expect(c!.status).toBe('in_progress');
    expect(c!.assigned_to).not.toBeNull();
    await t.admin`update projects set settings = '{}' where id = ${project}`;

    const empty = await createQuestionnaire(t.admin, tenant.id, project, { definition });
    const none = await post(me, `/projects/${project}/interviews`, {
      id: uuidv7(),
      caseId: await newCase(interviewer.id),
      questionnaireId: empty,
      mode: 'CAPI',
      deviceId: device,
    });
    expect(none.body.code).toBe('NO_PUBLISHED_VERSION');
  });
});
