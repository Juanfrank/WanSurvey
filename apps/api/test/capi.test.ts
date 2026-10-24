import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
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

const definition = {
  id: 'FIELD',
  title: { es: 'Campo' },
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

interface Checkout {
  versions: { id: string; compiled: CompiledQuestionnaire }[];
  cases: {
    caseId: string;
    context: { case: Record<string, unknown> };
    questionnaireVersionId: string;
    interview: { id: string } | null;
    lastSeq: number;
  }[];
  refused: { caseId: string; code: string }[];
}

describe('offline face-to-face interviewing', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let qid: string;
  let me: Session;
  let meUser: TestUser;
  let other: Session;
  let supervisor: Session;
  const device = 'device-tablet-0001';
  const tablet2 = 'device-tablet-0002';

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { definition, publish: true });
    meUser = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t.app, meUser);
    other = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]),
    );
    supervisor = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'supervisor', projectId: project }]),
    );
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  async function newCase(holder: string | null) {
    const id = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
      values (${id}, ${tenant.id}, ${project}, ${'F' + id.slice(-6)}, ${t.admin.json({ city: 'Cusco' })},
              ${holder ? 'assigned' : 'fresh'}, ${holder})`;
    return id;
  }
  /** Answers AGE on the device and returns the ops and the path, as the web client would. */
  function interviewOnDevice(co: Checkout, caseIdx: number, id: string, startedAt: string) {
    const c = co.cases[caseIdx]!;
    const v = co.versions.find((x) => x.id === c.questionnaireVersionId)!;
    const s = createInterview(v.compiled, {
      mode: 'CAPI',
      language: 'es',
      seed: id,
      now: () => new Date(startedAt),
      context: { case: c.context.case },
    });
    s.setAnswer('AGE', 30 + caseIdx);
    s.next();
    const ops = s.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: startedAt,
      source: e.source,
      reason: e.reason ?? null,
    }));
    return { ops, state: s.state(), path: s.pathKeys() };
  }

  it('downloads cases to one device, refusing others’ and those on another device', async () => {
    const mine = await newCase(meUser.id);
    const theirs = await newCase(null);
    const co = await post(me, `/projects/${project}/capi/checkout`, {
      deviceId: device,
      caseIds: [mine, theirs],
    });
    expect(co.status, JSON.stringify(co.body)).toBe(200);
    const body = co.body as Checkout;
    expect(body.cases.map((c) => c.caseId)).toEqual([mine]);
    expect(body.refused).toEqual([{ caseId: theirs, code: 'NOT_FOUND' }]);
    expect(body.versions).toHaveLength(1);
    expect(body.cases[0]!.context.case).toEqual({ city: 'Cusco' });
    const [row] = await t.admin`select checked_out_device from cases where id = ${mine}`;
    expect(row!.checked_out_device).toBe(device);
    // Another device of the same person cannot take it, nor start it online.
    const again = await post(me, `/projects/${project}/capi/checkout`, {
      deviceId: tablet2,
      caseIds: [mine],
    });
    expect(again.body.refused).toEqual([{ caseId: mine, code: 'CHECKED_OUT_ELSEWHERE' }]);
    const online = await post(me, `/projects/${project}/interviews`, {
      id: uuidv7(),
      caseId: mine,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: tablet2,
    });
    expect(online.body.code).toBe('CHECKED_OUT_ELSEWHERE');
    // Checking in frees it.
    const back = await post(me, `/projects/${project}/capi/checkin`, {
      deviceId: device,
      caseIds: [mine],
    });
    expect(back.body.checkedIn).toEqual([mine]);
  });

  it('creates interviews started offline when they sync, only from the device holding the case', async () => {
    const caseId = await newCase(meUser.id);
    const co = (
      await post(me, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: [caseId] })
    ).body as Checkout;
    const id = uuidv7();
    const startedAt = new Date(Date.now() - 3600_000).toISOString();
    const { ops, state, path } = interviewOnDevice(co, 0, id, startedAt);
    const start = {
      caseId,
      questionnaireVersionId: co.cases[0]!.questionnaireVersionId,
      mode: 'CAPI',
      language: 'es',
      startedAt,
    };
    // From another device, or by someone else: refused.
    const wrong = await post(me, '/interviews/sync', {
      deviceId: tablet2,
      interviews: [{ id, start, ops, state }],
    });
    expect(wrong.body.errors[id]).toBe('NOT_THIS_DEVICE');
    const notMine = await post(other, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id, start, ops, state }],
    });
    expect(notMine.body.errors[id]).toBe('NOT_THIS_DEVICE');
    // From the device: created with the device's id and start time, then a replay is harmless.
    const ok = await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id, start, ops, state }],
    });
    expect(ok.body).toMatchObject({ acks: { [id]: ops.length }, errors: {} });
    await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id, start, ops, state }],
    }).expect(200);
    const [iv] =
      await t.admin`select status, mode, started_at, device_id from interviews where id = ${id}`;
    expect(iv).toMatchObject({ status: 'in_progress', mode: 'CAPI', device_id: device });
    expect(new Date(iv!.started_at).toISOString()).toBe(startedAt);
    // Another device cannot write to it.
    const other2 = await post(me, '/interviews/sync', {
      deviceId: tablet2,
      interviews: [{ id, ops: [{ ...ops[0]!, seq: ops.length + 1 }] }],
    });
    expect(other2.body.errors[id]).toBe('NOT_THIS_DEVICE');
    const sub = await post(me, `/interviews/${id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path,
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const [c] = await t.admin`select status, disposition from cases where id = ${caseId}`;
    expect(c).toMatchObject({ status: 'finalised', disposition: 'COMPLETE' });
  });

  it('twenty interviews done offline all arrive and finalise in one sync', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await newCase(meUser.id));
    const co = (
      await post(me, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: ids })
    ).body as Checkout;
    expect(co.cases).toHaveLength(20);
    const items = co.cases.map((c, i) => {
      const id = uuidv7();
      const startedAt = new Date(Date.now() - (20 - i) * 60_000).toISOString();
      const run = interviewOnDevice(co, i, id, startedAt);
      return {
        id,
        run,
        item: {
          id,
          start: {
            caseId: c.caseId,
            questionnaireVersionId: c.questionnaireVersionId,
            mode: 'CAPI',
            language: 'es',
            startedAt,
          },
          ops: run.ops,
          state: run.state,
        },
      };
    });
    const res = await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: items.map((x) => x.item),
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.acks)).toHaveLength(20);
    expect(res.body.errors).toEqual({});
    for (const x of items)
      await post(me, `/interviews/${x.id}/submit`, {
        deviceId: device,
        seq: x.run.ops.length,
        path: x.run.path,
      }).expect(200);
    const done =
      await t.admin`select count(*)::int as n from cases where id in ${t.admin(ids)} and status = 'finalised'`;
    expect(done[0]!.n).toBe(20);
    const answers =
      await t.admin`select count(*)::int as n from interview_answer_events where interview_id in ${t.admin(items.map((x) => x.id))}`;
    expect(answers[0]!.n).toBe(20);
  });

  it('an interview in progress moves to the device that downloads its case', async () => {
    const caseId = await newCase(meUser.id);
    const id = uuidv7();
    await post(me, `/projects/${project}/interviews`, {
      id,
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: 'device-desktop-01',
    }).expect(200);
    const co = (
      await post(me, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: [caseId] })
    ).body as Checkout;
    expect(co.cases[0]!.interview?.id).toBe(id);
    const old = await post(me, '/interviews/sync', {
      deviceId: 'device-desktop-01',
      interviews: [
        {
          id,
          ops: [{ seq: 1, kind: 'paradata', type: 'pause', at: new Date().toISOString() }],
        },
      ],
    });
    expect(old.body.errors[id]).toBe('NOT_THIS_DEVICE');
  });

  it('a supervisor frees a case from a lost device, and it is recorded', async () => {
    const caseId = await newCase(meUser.id);
    await post(me, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: [caseId] });
    const detail = await supervisor.agent.get(`/api/v1/projects/${project}/cases/${caseId}`);
    expect(detail.body.canForceRelease).toBe(true);
    expect((await post(me, `/projects/${project}/cases/${caseId}/force-release`)).status).toBe(403);
    const r = await post(supervisor, `/projects/${project}/cases/${caseId}/force-release`);
    expect(r.body).toEqual({ released: true });
    const audit =
      await t.admin`select count(*)::int as n from audit_log where action = 'case.checkout_released' and target_id = ${caseId}`;
    expect(audit[0]!.n).toBe(1);
    // Now another device can take it.
    const co = await post(me, `/projects/${project}/capi/checkout`, {
      deviceId: tablet2,
      caseIds: [caseId],
    });
    expect(co.body.cases).toHaveLength(1);
  });
  it('an offline start keeps to the case’s questionnaire, one in use, and the caller’s permission', async () => {
    const u = await createUser(t.admin, tenant.id, [
      { role: 'interviewer', projectId: project },
      { role: 'interviewer', projectId: await createProject(t.admin, tenant.id) },
    ]);
    const s = await login(t.app, u);
    const caseId = await newCase(u.id);
    const co = (
      await post(s, `/projects/${project}/capi/checkout`, { deviceId: device, caseIds: [caseId] })
    ).body as Checkout;
    const startedAt = new Date().toISOString();
    const send = () => {
      const id = uuidv7();
      const { ops, state } = interviewOnDevice(co, 0, id, startedAt);
      const start = {
        caseId,
        questionnaireVersionId: co.cases[0]!.questionnaireVersionId,
        mode: 'CAPI',
        language: 'es',
        startedAt,
      };
      return post(s, '/interviews/sync', {
        deviceId: device,
        interviews: [{ id, start, ops, state }],
      }).then((r) => r.body.errors[id] as string | undefined);
    };
    // The case was moved to another questionnaire after it was downloaded.
    const other = await createQuestionnaire(t.admin, tenant.id, project, {
      definition,
      publish: true,
    });
    await t.admin`update cases set questionnaire_id = ${other} where id = ${caseId}`;
    expect(await send()).toBe('OTHER_QUESTIONNAIRE');
    await t.admin`update cases set questionnaire_id = null where id = ${caseId}`;
    // The questionnaire was disabled meanwhile.
    await t.admin`update questionnaires set state = 'disabled' where id = ${qid}`;
    expect(await send()).toBe('QUESTIONNAIRE_DISABLED');
    await t.admin`update questionnaires set state = 'active' where id = ${qid}`;
    // The interviewer no longer works on this project.
    await t.admin`delete from memberships where user_id = ${u.id} and project_id = ${project}`;
    expect(await send()).toBe('NOT_FOUND');
    const [n] = await t.admin`select count(*)::int as n from interviews where case_id = ${caseId}`;
    expect(n!.n).toBe(0);
  });
});
