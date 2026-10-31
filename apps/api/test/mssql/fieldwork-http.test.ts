import {
  createInterview,
  type CompiledQuestionnaire,
  type InterviewSession,
} from '@wansurvey/logic';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, get, newCase, post, setSettings } from './fixtures.js';
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

/**
 * The interview runtime over HTTP on SQL Server, the counterpart of test/interviews.test.ts:
 * starting once per case, numbered changes replayed safely, submission after the server checks the
 * path, the case's history, and the review of what was submitted.
 */
describe.skipIf(!configured)('SQL Server: interviews over HTTP', () => {
  let t: MssqlTestApp;
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
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    interviewer = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
    ]);
    me = await login(t, interviewer, tenant.slug);
    other = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]),
      tenant.slug,
    );
    supervisor = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor' }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    await t?.close();
  });

  const newHeld = (holder: string | null) =>
    newCase(t.owner, tenant.id, project, { holder, sample: { city: 'Lima' } });
  const session = (s: Started): InterviewSession =>
    createInterview(s.compiled, {
      mode: 'CAPI',
      language: s.interview.language,
      seed: s.interview.id,
      now: () => new Date(s.interview.startedAt),
      context: { case: s.context.case },
    });
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
  const row = async (query: ReturnType<typeof sql>) =>
    ((await query.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  it('starts once per case, binds the version, and moves the case to in progress', async () => {
    const caseId = await newHeld(interviewer.id);
    const id = randomUUID();
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
      (await post(me, `/projects/${project}/interviews`, { ...body, id: randomUUID() })).body
        .interview.id,
    ).toBe(id);
    const [c] = await row(sql`SELECT status FROM cases WHERE id = ${caseId}`);
    expect(c!.status).toBe('in_progress');
    // Someone who does not hold the case cannot start it; a supervisor does not conduct.
    expect(
      (await post(other, `/projects/${project}/interviews`, { ...body, id: randomUUID() })).status,
    ).toBe(404);
    expect((await post(supervisor, `/projects/${project}/interviews`, body)).status).toBe(403);
  });

  it('syncs changes idempotently and submits after the server re-checks the path', async () => {
    const caseId = await newHeld(interviewer.id);
    const id = randomUUID();
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
    const [stored] = await row(
      sql`SELECT COUNT(*) AS n FROM interview_answer_events WHERE interview_id = ${id}`,
    );
    expect(Number(stored!.n)).toBe(2);

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
    const [stored2] = await row(sql`SELECT answers, active_ms FROM interviews WHERE id = ${id}`);
    expect(JSON.parse(stored2!.answers as string)).toMatchObject({
      WORK: 1,
      HOURS: 40,
      NAME: 'Ana',
    });
    expect(stored2!.active_ms).toBe(5000);

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
    const [c] = await row(sql`SELECT status, disposition FROM cases WHERE id = ${caseId}`);
    expect(c).toEqual({ status: 'finalised', disposition: 'COMPLETE' });
    // A finished case cannot be started again.
    expect(
      (
        await post(me, `/projects/${project}/interviews`, {
          id: randomUUID(),
          caseId,
          questionnaireId: qid,
          mode: 'CAPI',
          deviceId: device,
        })
      ).body.code,
    ).toBe('CASE_CLOSED');

    // The answer history, oldest first, with who and why.
    const h = await get(supervisor, `/projects/${project}/cases/${caseId}/interviews`);
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
      sql`UPDATE interview_answer_events SET variable = 'x' WHERE interview_id = ${id}`.execute(
        t.owner,
      ),
    ).rejects.toThrow(/append-only/);

    // What was submitted waits in the review queue, and the supervisor can read it.
    const queue = await get(supervisor, `/projects/${project}/review/queue`);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(JSON.stringify(queue.body)).toContain(id);
    const review = await get(supervisor, `/review/interviews/${id}`);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
  });

  it('refuses to submit an unfinished interview, and resumes only for its holder', async () => {
    const caseId = await newHeld(interviewer.id);
    const id = randomUUID();
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
    expect((await get(me, `/interviews/${id}`)).body.interview.id).toBe(id);
    expect((await get(other, `/interviews/${id}`)).status).toBe(404);
  });

  it('in pool mode, starting on a free case takes it; no published version is refused', async () => {
    await setSettings(t.owner, project, { assignmentMode: 'pool' });
    const caseId = await newHeld(null);
    const r = await post(other, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'CATI',
      deviceId: device,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [c] = await row(sql`SELECT assigned_to, status FROM cases WHERE id = ${caseId}`);
    expect(c!.status).toBe('in_progress');
    expect(c!.assigned_to).not.toBeNull();
    await setSettings(t.owner, project, {});

    const empty = await createQuestionnaire(t.owner, tenant.id, project, { definition });
    const none = await post(me, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId: await newHeld(interviewer.id),
      questionnaireId: empty,
      mode: 'CAPI',
      deviceId: device,
    });
    expect(none.body.code).toBe('NO_PUBLISHED_VERSION');
  });

  /** Starts (or resumes) an interview on a case from a device. */
  async function startOn(caseId: string, deviceId: string, id = randomUUID(), mode = 'CAPI') {
    return post(me, `/projects/${project}/interviews`, {
      id,
      caseId,
      questionnaireId: qid,
      mode,
      deviceId,
    });
  }
  const stateOf = async (id: string) => {
    const [r] = await row(sql`SELECT state, state_version FROM interviews WHERE id = ${id}`);
    return { state: JSON.parse(r!.state as string), state_version: Number(r!.state_version) };
  };

  it('a late or repeated batch does not write its older snapshot over a newer one', async () => {
    const id = randomUUID();
    const started = (await startOn(await newHeld(interviewer.id), device, id)).body as Started;
    const s = session(started);
    s.setAnswer('WORK', 1);
    s.next();
    const first = ops(s, 0);
    const older = { id, ops: first, state: s.state() };
    s.setAnswer('HOURS', 40);
    s.next();
    const newer = { id, ops: [...first, ...ops(s, first.length)], state: s.state() };
    // The answer to the first send was lost; the next one (with everything) arrives first.
    const a = await post(me, '/interviews/sync', { deviceId: device, interviews: [newer] });
    expect(a.body.acks[id]).toBe(2);
    const b = await post(me, '/interviews/sync', { deviceId: device, interviews: [older] });
    expect(b.body.acks[id]).toBe(2);
    expect((await stateOf(id)).state.answers).toEqual({ WORK: 1, HOURS: 40 });
  });

  it('a device whose copy builds on an older state than another device wrote is refused', async () => {
    const caseId = await newHeld(interviewer.id);
    const id = randomUUID();
    const [phone, laptop] = ['device-phone-0001', 'device-laptop-001'];
    const started = (await startOn(caseId, phone, id)).body as Started & {
      interview: { stateVersion: number };
    };
    expect(started.interview.stateVersion).toBe(0);
    const s = session(started);
    s.setAnswer('WORK', 1);
    s.next();
    const r1 = await post(me, '/interviews/sync', {
      deviceId: phone,
      interviews: [{ id, ops: ops(s, 0), state: s.state(), baseVersion: 0 }],
    });
    expect(r1.body).toMatchObject({ acks: { [id]: 1 }, errors: {}, versions: { [id]: 1 } });
    const stale = s.state();

    // The laptop goes on with it, from the server's copy.
    const resumed = (await startOn(caseId, laptop)).body;
    expect(resumed.interview).toMatchObject({ stateVersion: 1, ownState: false });
    expect(resumed.lastSeq).toBe(0);
    const s2 = createInterview(started.compiled, {
      mode: 'CAPI',
      language: 'en',
      seed: id,
      now: () => new Date(started.interview.startedAt),
      context: { case: started.context.case },
      state: resumed.interview.state,
    });
    s2.setAnswer('HOURS', 40);
    s2.next();
    const r2 = await post(me, '/interviews/sync', {
      deviceId: laptop,
      interviews: [{ id, ops: ops(s2, 0), state: s2.state(), baseVersion: 1 }],
    });
    expect(r2.body.versions[id]).toBe(2);

    // Back on the phone: the server's copy is newer than the phone's and not the phone's own.
    const back = (await startOn(caseId, phone)).body;
    expect(back.interview).toMatchObject({ stateVersion: 2, ownState: false });
    expect(back.interview.state.answers).toEqual({ WORK: 1, HOURS: 40 });
    // A phone still on its old copy: the change is recorded, its snapshot is not kept.
    const para = (seq: number) => ({
      kind: 'paradata' as const,
      seq,
      type: 'pause' as const,
      at: new Date().toISOString(),
      payload: {},
    });
    const r3 = await post(me, '/interviews/sync', {
      deviceId: phone,
      interviews: [{ id, ops: [para(2)], state: stale, baseVersion: 1 }],
    });
    expect(r3.body).toMatchObject({ acks: { [id]: 2 }, errors: { [id]: 'STALE_STATE' } });
    expect(r3.body.versions[id]).toBeUndefined();
    expect(await stateOf(id)).toMatchObject({
      state_version: 2,
      state: { answers: { WORK: 1, HOURS: 40 } },
    });
    // On the server's copy it goes on; and when an answer is lost, its own newer version is no
    // reason to refuse the next send.
    const r4 = await post(me, '/interviews/sync', {
      deviceId: phone,
      interviews: [{ id, ops: [para(3)], state: back.interview.state, baseVersion: 2 }],
    });
    expect(r4.body).toMatchObject({ errors: {}, versions: { [id]: 3 } });
    const r5 = await post(me, '/interviews/sync', {
      deviceId: phone,
      interviews: [{ id, ops: [para(4)], state: back.interview.state, baseVersion: 2 }],
    });
    expect(r5.body).toMatchObject({ errors: {}, versions: { [id]: 4 } });
    // Devices that send no version keep working as before.
    const r6 = await post(me, '/interviews/sync', {
      deviceId: phone,
      interviews: [{ id, ops: [para(5)], state: back.interview.state }],
    });
    expect(r6.body).toMatchObject({ errors: {}, versions: { [id]: 5 } });
  });

  it('does not take over an interview open in another mode', async () => {
    const caseId = await newHeld(interviewer.id);
    const [v] = await row(
      sql`SELECT v.id FROM questionnaire_versions v WHERE v.questionnaire_id = ${qid}`,
    );
    // A respondent is answering on the web.
    const web = randomUUID();
    await row(
      sql`INSERT INTO interviews (id, tenant_id, project_id, case_id, questionnaire_version_id, mode, language, device_id)
          VALUES (${web}, ${tenant.id}, ${project}, ${caseId}, ${v!.id}, 'CAWI', 'en', 'browser-1')`,
    );
    const r = await startOn(caseId, device);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'IN_PROGRESS_OTHER_MODE', mode: 'CAWI' });
    const [kept] = await row(
      sql`SELECT mode, device_id, interviewer_id FROM interviews WHERE id = ${web}`,
    );
    expect(kept).toEqual({ mode: 'CAWI', device_id: 'browser-1', interviewer_id: null });
  });

  it('a device sync is refused in a project where the interviewer no longer conducts', async () => {
    const elsewhere = await createProject(t.owner, tenant.id);
    const u = await createUser(t.owner, tenant.id, [
      { role: 'interviewer', projectId: project },
      { role: 'interviewer', projectId: elsewhere },
    ]);
    const s = await login(t, u, tenant.slug);
    const caseId = await newHeld(u.id);
    const id = randomUUID();
    const started = await post(s, `/projects/${project}/interviews`, {
      id,
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: device,
    });
    expect(started.status).toBe(200);
    await row(sql`DELETE FROM memberships WHERE user_id = ${u.id} AND project_id = ${project}`);
    const pause = {
      kind: 'paradata',
      seq: 1,
      type: 'pause',
      at: new Date().toISOString(),
      payload: {},
    };
    const r = await post(s, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id, ops: [pause] }],
    });
    expect(r.body).toMatchObject({ acks: {}, errors: { [id]: 'NOT_FOUND' } });
  });
});
