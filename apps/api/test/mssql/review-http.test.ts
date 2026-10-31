import {
  createInterview,
  type CompiledQuestionnaire,
  type InterviewSession,
} from '@wansurvey/logic';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuestionnaire, newCase as mkCase } from './fixtures.js';
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
  id: 'REVIEW',
  title: es('Revisión'),
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
          id: 'WORK',
          name: 'WORK',
          type: 'single',
          text: es('¿Trabaja?'),
          options: [
            { code: 1, label: es('Sí') },
            { code: 2, label: es('No') },
          ],
          skips: [{ when: 'WORK == 2', to: 'END' }],
        },
        { kind: 'question', id: 'HOURS', name: 'HOURS', type: 'numeric', text: es('¿Horas?') },
        {
          kind: 'question',
          id: 'OCC',
          name: 'OCC',
          type: 'single',
          text: es('¿Ocupación?'),
          options: [
            { code: 1, label: es('Agricultura') },
            { code: 9, label: es('Otra'), otherSpecify: true },
          ],
        },
      ],
    },
  ],
};

interface Payload {
  interview: { id: string; startedAt: string };
  context: { case: Record<string, unknown> };
  compiled: CompiledQuestionnaire;
  lastSeq: number;
}

/** Answer review and coding over HTTP on SQL Server (test/review.test.ts). */
describe.skipIf(!configured)('SQL Server: answer review over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let iUser: TestUser;
  let me: Session;
  let sup: Session;
  let reviewer: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t, iUser, tenant.slug);
    sup = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: project }]),
      tenant.slug,
    );
    reviewer = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'reviewer', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const j = (v: unknown) => JSON.parse(v as string);

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  const newCase = () => mkCase(t.owner, tenant.id, project, { holder: iUser.id });
  const session = (p: Payload, state?: unknown): InterviewSession =>
    createInterview(p.compiled, {
      mode: 'CAPI',
      language: 'es',
      seed: p.interview.id,
      now: () => new Date(p.interview.startedAt),
      context: { case: p.context.case },
      ...(state ? { state: state as never } : {}),
    });
  function ops(s: InterviewSession, from: number) {
    return s.drainEvents().map((e, i) => ({
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
  /** Interviews a case to the end and submits it. */
  async function interview(answers: [string, unknown][], device = 'device-review-01') {
    const caseId = await newCase();
    const p = (
      await post(me, `/projects/${project}/interviews`, {
        id: randomUUID(),
        caseId,
        questionnaireId: qid,
        mode: 'CAPI',
        deviceId: device,
      })
    ).body as Payload;
    const s = session(p);
    for (const [k, v] of answers) {
      s.setAnswer(k, v as never);
      s.next();
    }
    const o = ops(s, 0);
    await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id: p.interview.id, ops: o, state: s.state(), activeMs: 120_000 }],
    }).expect(200);
    const sub = await post(me, `/interviews/${p.interview.id}/submit`, {
      deviceId: device,
      seq: o.length,
      path: s.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    return { id: p.interview.id, caseId };
  }

  it('return → fix → resubmit → approve, with the history of both rounds', async () => {
    const { id, caseId } = await interview([
      ['AGE', 30],
      ['WORK', 1],
      ['HOURS', 40],
      ['OCC', 1],
    ]);
    const q = await reviewer.agent.get(`/api/v1/projects/${project}/review/queue`);
    expect(q.body.rows.map((r: { id: string }) => r.id)).toContain(id);
    const row = q.body.rows.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({ status: 'submitted', mode: 'CAPI', submissions: 1 });

    // Interviewers cannot review; returning needs a comment.
    expect(
      (await post(me, `/review/interviews/${id}/transition`, { to: 'in_review' })).status,
    ).toBe(403);
    await post(reviewer, `/review/interviews/${id}/transition`, { to: 'in_review' }).expect(200);
    const noComment = await post(reviewer, `/review/interviews/${id}/transition`, {
      to: 'returned',
    });
    expect(noComment.body.code).toBe('COMMENT_REQUIRED');
    await post(reviewer, `/review/interviews/${id}/comments`, {
      variable: 'HOURS',
      body: 'Revise las horas: el formulario dice 45.',
    }).expect(201);
    await post(reviewer, `/review/interviews/${id}/transition`, {
      to: 'returned',
      comment: 'Corrija las horas, por favor.',
    }).expect(200);
    const [c1] = await rows(sql`SELECT status FROM cases WHERE id = ${caseId}`);
    expect(c1!.status).toBe('in_progress');

    // The interviewer sees it, takes it on another device, fixes HOURS and resubmits.
    const mine = await me.agent.get(`/api/v1/projects/${project}/review/returned`);
    expect(mine.body).toEqual([
      expect.objectContaining({ id, comment: 'Corrija las horas, por favor.' }),
    ]);
    const d0 = await me.agent.get(`/api/v1/review/interviews/${id}`);
    expect(d0.body.comments.map((c: { variable: string | null }) => c.variable)).toEqual([
      'HOURS',
      null,
    ]);
    expect(d0.body.allowed).toEqual([]);
    const device2 = 'device-review-02';
    const taken = (await post(me, `/interviews/${id}/takeover`, { deviceId: device2 }))
      .body as Payload & {
      interview: { state: unknown };
    };
    const s = session(taken, taken.interview.state);
    s.jumpTo('HOURS');
    s.setAnswer('HOURS', 45);
    while (s.status().state === 'in_progress' && s.next().ok);
    const o = ops(s, taken.lastSeq);
    await post(me, '/interviews/sync', {
      deviceId: device2,
      interviews: [{ id, ops: o, state: s.state() }],
    }).expect(200);
    await post(me, `/review/interviews/${id}/comments`, {
      variable: 'HOURS',
      body: 'Corregido.',
    }).expect(201);
    await post(me, `/interviews/${id}/submit`, {
      deviceId: device2,
      seq: taken.lastSeq + o.length,
      path: s.pathKeys(),
    }).expect(200);
    const [iv] = await rows(
      sql`SELECT status, submissions, answers FROM interviews WHERE id = ${id}`,
    );
    expect(iv).toMatchObject({ status: 'submitted', submissions: 2 });
    expect(j(iv!.answers).HOURS).toBe(45);
    const [c2] = await rows(sql`SELECT status FROM cases WHERE id = ${caseId}`);
    expect(c2!.status).toBe('finalised');

    // History: the first answer (40) and the fix (45), and all comments.
    const d = await reviewer.agent.get(`/api/v1/review/interviews/${id}`);
    const hours = d.body.history.filter((h: { variable: string }) => h.variable === 'HOURS');
    expect(hours.map((h: { newValue: number }) => h.newValue)).toEqual([40, 45]);
    expect(d.body.comments).toHaveLength(3);
    expect(d.body.allowed).toEqual(['in_review', 'returned', 'approved', 'rejected']);
    await post(reviewer, `/review/interviews/${id}/transition`, { to: 'in_review' }).expect(200);
    // The reviewer role may also approve; here the supervisor does.
    await post(sup, `/review/interviews/${id}/transition`, { to: 'approved' }).expect(200);
    const audit = await rows(
      sql`SELECT action FROM audit_log WHERE target_id = ${id} ORDER BY at, id`,
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['interview.returned', 'interview.approved']),
    );
  });

  it('corrections re-run the logic: path changes clear answers; opening new questions is refused', async () => {
    const { id } = await interview([
      ['AGE', 30],
      ['WORK', 1],
      ['HOURS', 40],
      ['OCC', 1],
    ]);
    expect(
      (
        await post(reviewer, `/review/interviews/${id}/correct`, {
          variable: 'AGE',
          value: 31,
          reason: 'Según el DNI',
        })
      ).status,
    ).toBe(403);
    const bad = await post(sup, `/review/interviews/${id}/correct`, {
      variable: 'AGE',
      value: 'treinta',
      reason: 'Prueba',
    });
    expect(bad.status).toBe(400);
    const r = await post(sup, `/review/interviews/${id}/correct`, {
      variable: 'WORK',
      value: 2,
      reason: 'El respondente no trabaja',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.cleared).toEqual(expect.arrayContaining(['HOURS', 'OCC']));
    const [iv] = await rows(sql`SELECT answers FROM interviews WHERE id = ${id}`);
    expect(j(iv!.answers)).toMatchObject({ WORK: 2 });
    expect(j(iv!.answers).HOURS).toBeUndefined();
    const ev = await rows(sql`SELECT variable, source, reason FROM interview_answer_events
      WHERE interview_id = ${id} AND device_id = 'review' ORDER BY seq`);
    expect(ev[0]).toMatchObject({ variable: 'WORK', source: 'reviewer', reason: 'correction' });
    expect(ev.some((e) => e.variable === 'HOURS' && e.reason === 'path_change')).toBe(true);
    // Back to "works": the answers that fell off come back.
    const back = await post(sup, `/review/interviews/${id}/correct`, {
      variable: 'WORK',
      value: 1,
      reason: 'Sí trabaja',
    });
    expect(back.body.restored).toEqual(expect.arrayContaining(['HOURS', 'OCC']));
    // An interview that never had HOURS cannot be switched to "works" by a reviewer.
    const short = await interview([
      ['AGE', 50],
      ['WORK', 2],
    ]);
    const open = await post(sup, `/review/interviews/${short.id}/correct`, {
      variable: 'WORK',
      value: 1,
      reason: 'Prueba',
    });
    expect(open.body).toMatchObject({ code: 'PATH_INCOMPLETE', opened: 'HOURS' });
    await post(sup, `/review/interviews/${id}/transition`, { to: 'approved' }).expect(200);
    const late = await post(sup, `/review/interviews/${id}/correct`, {
      variable: 'AGE',
      value: 32,
      reason: 'Tarde',
    });
    expect(late.body.code).toBe('NOT_IN_REVIEW');
  });

  it('rejecting sends the case back; flags and the queue filters work', async () => {
    const { id, caseId } = await interview([
      ['AGE', 30],
      ['WORK', 2],
    ]);
    await sql`UPDATE interviews SET flags = '{"speeding": 400}' WHERE id = ${id}`.execute(t.owner);
    const flagged = await sup.agent.get(`/api/v1/projects/${project}/review/queue?flag=speeding`);
    expect(flagged.body.rows.map((r: { id: string }) => r.id)).toEqual([id]);
    await post(sup, `/review/interviews/${id}/transition`, {
      to: 'rejected',
      comment: 'Entrevista inventada',
    }).expect(200);
    const [c] = await rows(sql`SELECT status, disposition FROM cases WHERE id = ${caseId}`);
    expect(c).toMatchObject({ status: 'assigned', disposition: null });
    const bad = await post(sup, `/review/interviews/${id}/transition`, { to: 'approved' });
    expect(bad.body.code).toBe('BAD_TRANSITION');
    // Others' interviews are not visible to an interviewer.
    const other = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]),
      tenant.slug,
    );
    expect((await other.agent.get(`/api/v1/review/interviews/${id}`)).status).toBe(404);
  });

  it('codes "other" texts in bulk and writes the code to every interview', async () => {
    const a = await interview([
      ['AGE', 40],
      ['WORK', 1],
      ['HOURS', 10],
      ['OCC', 9],
      ['OCC_OTHER', 'Carpintero'],
    ]);
    await interview([
      ['AGE', 41],
      ['WORK', 1],
      ['HOURS', 12],
      ['OCC', 9],
      ['OCC_OTHER', ' carpintero '],
    ]);
    const [iv] = await rows(sql`SELECT flags FROM interviews WHERE id = ${a.id}`);
    expect(j(iv!.flags).otherText).toBe(1);
    const overview = await sup.agent.get(`/api/v1/projects/${project}/coding`);
    expect(overview.body).toEqual([{ variable: 'OCC_OTHER', total: 2, uncoded: 2 }]);
    await sup.agent
      .put(`/api/v1/projects/${project}/coding/OCC_OTHER/codes`)
      .set('x-csrf-token', sup.csrf)
      .send({ codes: [{ code: 71, label: 'Construcción' }] })
      .expect(200);
    const r = await post(sup, `/projects/${project}/coding/OCC_OTHER/assign`, {
      texts: ['Carpintero'],
      code: 71,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changed).toBe(2);
    expect(r.body.texts).toEqual([expect.objectContaining({ count: 2, code: 71 })]);
    const [coded] = await rows(sql`SELECT answers FROM interviews WHERE id = ${a.id}`);
    expect(j(coded!.answers).OCC_CODE).toBe(71);
    // A code in use cannot be removed.
    const rm = await sup.agent
      .put(`/api/v1/projects/${project}/coding/OCC_OTHER/codes`)
      .set('x-csrf-token', sup.csrf)
      .send({ codes: [] });
    expect(rm.body.code).toBe('CODE_IN_USE');
  });
  it('codes of "other" texts outlive corrections and syncs, while their text stays', async () => {
    const { id } = await interview([
      ['AGE', 50],
      ['WORK', 1],
      ['HOURS', 20],
      ['OCC', 9],
      ['OCC_OTHER', 'Albañil'],
    ]);
    await sup.agent
      .put(`/api/v1/projects/${project}/coding/OCC_OTHER/codes`)
      .set('x-csrf-token', sup.csrf)
      .send({
        codes: [
          { code: 71, label: 'Construcción' },
          { code: 72, label: 'Obras' },
        ],
      })
      .expect(200);
    await post(sup, `/projects/${project}/coding/OCC_OTHER/assign`, {
      texts: ['Albañil'],
      code: 72,
    }).expect(200);
    const code = async () =>
      (
        j((await rows(sql`SELECT answers FROM interviews WHERE id = ${id}`))[0]!.answers) as {
          OCC_CODE?: number;
        }
      ).OCC_CODE;
    expect(await code()).toBe(72);
    // A reviewer's correction rebuilds the answers: the code stays.
    await post(sup, `/review/interviews/${id}/correct`, {
      variable: 'AGE',
      value: 51,
      reason: 'Según el documento',
    }).expect(200);
    expect(await code()).toBe(72);
    // Returned and fixed on a device: the code stays while the text does, then goes with it.
    await post(sup, `/review/interviews/${id}/transition`, {
      to: 'returned',
      comment: 'Revise las horas.',
    }).expect(200);
    const device2 = 'device-review-03';
    const taken = (await post(me, `/interviews/${id}/takeover`, { deviceId: device2 }))
      .body as Payload & { interview: { state: unknown } };
    const s = session(taken, taken.interview.state);
    s.jumpTo('HOURS');
    s.setAnswer('HOURS', 25);
    let seq = taken.lastSeq;
    const send = async () => {
      const o = ops(s, seq);
      seq += o.length;
      await post(me, '/interviews/sync', {
        deviceId: device2,
        interviews: [{ id, ops: o, state: s.state() }],
      }).expect(200);
    };
    await send();
    expect(await code()).toBe(72);
    s.jumpTo('OCC_OTHER');
    s.setAnswer('OCC_OTHER', 'Gasfitero');
    await send();
    expect(await code()).toBeUndefined();
  });
});
