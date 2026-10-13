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
  id: 'PHONE',
  title: { es: 'Teléfono' },
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
  scripts: [
    {
      id: 'HELLO',
      anchor: { at: 'start' },
      modes: ['CATI'],
      body: { es: 'Buenos días, llamo a {{case.city}}.' },
    },
    {
      id: 'BUSY',
      anchor: { at: 'callOutcome', outcome: 'refusal' },
      modes: ['CATI'],
      body: { es: 'Gracias por su tiempo.' },
    },
  ],
};

const ALL_DAY = { from: '00:00', to: '00:00' };

describe('telephone interviewing', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  const device = 'device-cati-0001';

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);

  /** A project of its own per test, with all-day calling hours unless given. */
  async function setup(cati: object = {}, opts: { pool?: boolean } = {}) {
    const project = await createProject(t.admin, tenant.id);
    const qid = await createQuestionnaire(t.admin, tenant.id, project, {
      definition,
      publish: true,
    });
    const settings = {
      assignmentMode: opts.pool ? 'pool' : 'assigned',
      cati: { callingHours: ALL_DAY, maxAttempts: 3, ...cati },
    };
    await t.admin`update projects set settings = ${t.admin.json(settings)}, timezone = 'America/Lima' where id = ${project}`;
    const users: TestUser[] = [];
    const sessions: Session[] = [];
    for (let i = 0; i < 2; i++) {
      const u = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
      users.push(u);
      sessions.push(await login(t.app, u));
    }
    async function newCase(
      holder: string | null,
      x: { priority?: number; timezone?: string; phone?: boolean } = {},
    ) {
      const id = uuidv7();
      const sample = { city: 'Lima', ...(x.timezone ? { timezone: x.timezone } : {}) };
      await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to, priority)
        values (${id}, ${tenant.id}, ${project}, ${'T' + id.slice(-6)}, ${t.admin.json(sample)},
                ${holder ? 'assigned' : 'fresh'}, ${holder}, ${x.priority ?? 0})`;
      if (x.phone !== false)
        await t.admin`insert into contacts (id, tenant_id, case_id, type, value, label)
          values (${uuidv7()}, ${tenant.id}, ${id}, 'phone', '+51987654321', 'Móvil')`;
      return id;
    }
    return { project, qid, users, sessions, newCase };
  }

  it('serves cases best first, locks them, and says why when there is none', async () => {
    const { project, users, sessions, newCase } = await setup();
    const [u] = users;
    const [me] = sessions;
    const low = await newCase(u!.id);
    const high = await newCase(u!.id, { priority: 5 });
    await newCase(u!.id, { phone: false });
    await newCase(u!.id, { timezone: 'Asia/Tokyo' }); // all day: still eligible

    const a = await post(me!, `/projects/${project}/cati/next`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.case.id).toBe(high);
    expect(a.body.phones).toEqual([
      expect.objectContaining({ value: '+51987654321', label: 'Móvil' }),
    ]);
    expect(a.body.scripts.intro).toEqual([{ id: 'HELLO', text: 'Buenos días, llamo a Lima.' }]);
    expect(a.body.scripts.outcomes.refusal[0].text).toBe('Gracias por su tiempo.');
    // Showing the numbers is recorded once per case (K5).
    const views =
      await t.admin`select count(*)::int as n from audit_log where action = 'case.pii_viewed' and target_id = ${high}`;
    expect(views[0]!.n).toBe(1);
    // Asking again returns the same open call.
    const again = await post(me!, `/projects/${project}/cati/next`);
    expect(again.body.attempt.id).toBe(a.body.attempt.id);
    const [locked] = await t.admin`select call_lock_user_id from cases where id = ${high}`;
    expect(locked!.call_lock_user_id).toBe(u!.id);

    await post(me!, `/cati/attempts/${a.body.attempt.id}/release`).expect(200);
    const b = await post(me!, `/projects/${project}/cati/next`);
    expect(b.body.case.id).toBe(high); // a release is not an attempt
    await post(me!, `/cati/attempts/${b.body.attempt.id}/outcome`, {
      outcome: 'wrong_number',
    }).expect(200);
    const c = await post(me!, `/projects/${project}/cati/next`);
    expect(c.body.case.id).toBe(low);
  });

  it('schedules retries, finalises after the last attempt, and books callbacks in hours', async () => {
    const { project, users, sessions, newCase } = await setup({
      callingHours: { from: '09:00', to: '21:00' },
    });
    const [u] = users;
    const [me] = sessions;
    const caseId = await newCase(u!.id);
    // Calling hours may be closed in Lima now; open them for the call itself.
    await t.admin`update projects set settings = jsonb_set(settings, '{cati,callingHours}', ${t.admin.json(ALL_DAY)}) where id = ${project}`;
    const a = await post(me!, `/projects/${project}/cati/next`);
    const phone = a.body.phones[0].id;
    const busy = await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
      outcome: 'busy',
      contactId: phone,
      note: 'Ocupado',
    });
    expect(busy.body).toMatchObject({ disposition: 'BUSY', final: false });
    const [row] =
      await t.admin`select attempts, disposition, next_contact_at, call_lock_user_id from cases where id = ${caseId}`;
    expect(row).toMatchObject({ attempts: 1, disposition: 'BUSY', call_lock_user_id: null });
    expect(new Date(row!.next_contact_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const [att] =
      await t.admin`select number_masked, outcome from call_attempts where id = ${a.body.attempt.id}`;
    expect(att).toMatchObject({ number_masked: '••4321', outcome: 'busy' });
    // Not due yet.
    const none = await post(me!, `/projects/${project}/cati/next`);
    expect(none.status).toBe(204);
    expect(none.headers['x-queue-reason']).toBe('empty');
    expect(none.headers['x-next-callback']).toBeDefined();
    // A recorded call cannot change.
    await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, { outcome: 'refusal' }).expect(
      409,
    );
    await expect(
      t.admin`update call_attempts set note = 'x' where id = ${a.body.attempt.id}`,
    ).rejects.toThrow(/cannot change/);

    // Callbacks: outside the respondent's hours is refused, inside is booked.
    await t.admin`update cases set next_contact_at = null where id = ${caseId}`;
    await t.admin`update projects set settings = jsonb_set(settings, '{cati,callingHours}', ${t.admin.json({ from: '09:00', to: '21:00' })}) where id = ${project}`;
    await t.admin`update cases set sample = sample || '{"timezone":"UTC"}' where id = ${caseId}`;
    // Bypass the hours check of the queue by serving with all-day hours, then restore.
    await t.admin`update projects set settings = jsonb_set(settings, '{cati,callingHours}', ${t.admin.json(ALL_DAY)}) where id = ${project}`;
    const b = await post(me!, `/projects/${project}/cati/next`);
    await t.admin`update projects set settings = jsonb_set(settings, '{cati,callingHours}', ${t.admin.json({ from: '09:00', to: '21:00' })}) where id = ${project}`;
    const tomorrow = new Date(Date.now() + 86_400_000);
    const at = (h: number) =>
      new Date(
        Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), h),
      ).toISOString();
    const late = await post(me!, `/cati/attempts/${b.body.attempt.id}/outcome`, {
      outcome: 'callback',
      callbackAt: at(23),
    });
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('OUTSIDE_CALLING_HOURS');
    const ok = await post(me!, `/cati/attempts/${b.body.attempt.id}/outcome`, {
      outcome: 'appointment',
      callbackAt: at(10),
      callbackFor: 'me',
    });
    expect(ok.body).toMatchObject({ disposition: 'CALLBACK', final: false });
    const cbs = await me!.agent.get(`/api/v1/projects/${project}/cati/callbacks`);
    expect(cbs.body).toEqual([
      expect.objectContaining({ caseId, mine: true, timezone: 'UTC', at: at(10) }),
    ]);

    // The last allowed attempt without contact ends the case.
    await t.admin`update cases set next_contact_at = null, disposition = null, attempts = 2 where id = ${caseId}`;
    await t.admin`update projects set settings = jsonb_set(settings, '{cati,callingHours}', ${t.admin.json(ALL_DAY)}) where id = ${project}`;
    const c = await post(me!, `/projects/${project}/cati/next`);
    const last = await post(me!, `/cati/attempts/${c.body.attempt.id}/outcome`, {
      outcome: 'no_answer',
    });
    expect(last.body).toMatchObject({ disposition: 'NON_CONTACT', final: true });
    const [fin] = await t.admin`select status, disposition from cases where id = ${caseId}`;
    expect(fin).toMatchObject({ status: 'finalised', disposition: 'NON_CONTACT' });
    const calls = await me!.agent.get(`/api/v1/projects/${project}/cases/${caseId}/calls`);
    expect(calls.body.map((x: { outcome: string }) => x.outcome)).toEqual([
      'no_answer',
      'appointment',
      'busy',
    ]);
  });

  it('lists callbacks with who booked them, and calls one now within the queue rules', async () => {
    const { project, users, sessions, newCase } = await setup();
    const [u, v] = users;
    const [me, other] = sessions;
    const first = await newCase(u!.id, { priority: 5, timezone: 'UTC' });
    const second = await newCase(u!.id);
    const a = await post(me!, `/projects/${project}/cati/next`);
    expect(a.body.case.id).toBe(first);
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
      outcome: 'callback',
      callbackAt: inAnHour,
      callbackFor: 'me',
      note: 'Llamar después del almuerzo',
    }).expect(200);

    const list = await me!.agent.get(`/api/v1/projects/${project}/cati/callbacks`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        caseId: first,
        mine: true,
        forUserName: u!.email,
        kind: 'callback',
        bookedBy: u!.email,
        note: 'Llamar después del almuerzo',
        due: false,
        attempts: 1,
        // Not due yet, but in calling hours: the caller may call it early.
        callableNow: true,
        reason: null,
      }),
    ]);
    expect(list.body[0]).not.toHaveProperty('phones');

    // Someone else cannot call a case that is not theirs.
    const theirs = await post(other!, `/projects/${project}/cati/next`, { caseId: first });
    expect(theirs.status).toBe(409);
    expect(theirs.body).toMatchObject({ code: 'CANNOT_CALL', reason: 'not_yours' });

    // Call now: that case is served, ahead of the queue, and locked to the caller.
    const now = await post(me!, `/projects/${project}/cati/next`, { caseId: first });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(now.body.case.id).toBe(first);
    const [locked] = await t.admin`select call_lock_user_id from cases where id = ${first}`;
    expect(locked!.call_lock_user_id).toBe(u!.id);
    // While that call is open, another case cannot be started.
    const busy = await post(me!, `/projects/${project}/cati/next`, { caseId: second });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('CALL_OPEN');
    await post(me!, `/cati/attempts/${now.body.attempt.id}/release`).expect(200);

    // Outside the respondent's calling hours it is listed as such and refused.
    const h = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
    const hh = (n: number) => `${String(n % 24).padStart(2, '0')}:00`;
    await t.admin`update projects set settings = jsonb_set(settings, '{cati,callingHours}', ${t.admin.json({ from: hh(h), to: hh(h + 1) })}) where id = ${project}`;
    const closed = await me!.agent.get(`/api/v1/projects/${project}/cati/callbacks`);
    expect(closed.body[0]).toMatchObject({ callableNow: false, reason: 'outside_hours' });
    const refused = await post(me!, `/projects/${project}/cati/next`, { caseId: first });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CANNOT_CALL', reason: 'outside_hours' });
    void v;
  });

  it('answered starts the telephone interview; submitting closes the call', async () => {
    const { project, qid, users, sessions, newCase } = await setup();
    const [u] = users;
    const [me] = sessions;
    const caseId = await newCase(u!.id);
    const a = await post(me!, `/projects/${project}/cati/next`);
    const id = uuidv7();
    const r = await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
      outcome: 'answered',
      contactId: a.body.phones[0].id,
      interview: { id, deviceId: device, questionnaireId: qid },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.interview.interview).toMatchObject({ id, mode: 'CATI', language: 'es' });
    // While the interview runs, the open call comes back from `next`.
    const open = await post(me!, `/projects/${project}/cati/next`);
    expect(open.body.attempt).toMatchObject({ id: a.body.attempt.id, interviewId: id });

    const p = r.body.interview as {
      compiled: CompiledQuestionnaire;
      interview: { startedAt: string };
      context: { case: Record<string, unknown> };
    };
    const s = createInterview(p.compiled, {
      mode: 'CATI',
      language: 'es',
      seed: id,
      now: () => new Date(p.interview.startedAt),
      context: { case: p.context.case },
    });
    s.setAnswer('AGE', 40);
    s.next();
    expect(s.scriptsFor({ at: 'start' })[0]!.text).toContain('Lima');
    const ops = s.drainEvents().map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    await post(me!, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id, ops, state: s.state() }],
    }).expect(200);
    const sub = await post(me!, `/interviews/${id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path: s.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const [att] =
      await t.admin`select outcome, disposition, ended_at, interview_id from call_attempts where id = ${a.body.attempt.id}`;
    expect(att).toMatchObject({ outcome: 'answered', disposition: 'COMPLETE', interview_id: id });
    expect(att!.ended_at).not.toBeNull();
    const [c] =
      await t.admin`select status, disposition, attempts, call_lock_user_id from cases where id = ${caseId}`;
    expect(c).toMatchObject({
      status: 'finalised',
      disposition: 'COMPLETE',
      attempts: 1,
      call_lock_user_id: null,
    });
  });

  it('an interrupted interview becomes a callback, or a break-off', async () => {
    const { project, qid, users, sessions, newCase } = await setup();
    const [u] = users;
    const [me] = sessions;
    const caseId = await newCase(u!.id);
    const a = await post(me!, `/projects/${project}/cati/next`);
    const id = uuidv7();
    await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
      outcome: 'answered',
      interview: { id, deviceId: device, questionnaireId: qid },
    }).expect(200);
    // Only a callback or refusal can end an answered call.
    expect(
      (await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, { outcome: 'busy' })).body
        .code,
    ).toBe('CALL_ANSWERED');
    await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
      outcome: 'refusal',
    }).expect(200);
    const [c] = await t.admin`select status, disposition, attempts from cases where id = ${caseId}`;
    expect(c).toMatchObject({ status: 'finalised', disposition: 'BREAK_OFF', attempts: 1 });
    const [i] = await t.admin`select status from interviews where id = ${id}`;
    expect(i!.status).toBe('broken_off');
  });

  it('never serves one case to two callers at once', async () => {
    const { project, users, sessions, newCase } = await setup({}, { pool: true });
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) ids.add(await newCase(null));
    expect(users).toHaveLength(2);
    const rounds = await Promise.all(
      [0, 1, 0, 1, 0, 1].map(async (k, i) => {
        // Each caller asks three times, simultaneously; every answer is a new case to them.
        const s = sessions[k]!;
        const r = await post(s, `/projects/${project}/cati/next`);
        return { k, i, r };
      }),
    );
    const served = rounds.filter((x) => x.r.status === 200);

    // Each caller has one open call; both got one, and they differ.
    const byCaller = new Map<number, Set<string>>();
    for (const x of served) {
      byCaller.set(x.k, (byCaller.get(x.k) ?? new Set()).add(x.r.body.case.id));
    }
    expect(byCaller.get(0)?.size).toBe(1);
    expect(byCaller.get(1)?.size).toBe(1);
    expect([...byCaller.get(0)!][0]).not.toBe([...byCaller.get(1)!][0]);
    const open =
      await t.admin`select count(*)::int as n from call_attempts where project_id = ${project} and ended_at is null`;
    expect(open[0]!.n).toBe(2);
  });

  it('lets project managers change calling settings', async () => {
    const { project } = await setup();
    const pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
    const res = await pm.agent
      .patch(`/api/v1/projects/${project}`)
      .set('x-csrf-token', pm.csrf)
      .send({
        settings: {
          cati: {
            callingHours: { from: '10:00', to: '20:00' },
            maxAttempts: 5,
            retryMinutes: { no_answer: 60, busy: 10, voicemail: 120 },
          },
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.settings.cati).toMatchObject({ maxAttempts: 5 });
    const bad = await pm.agent
      .patch(`/api/v1/projects/${project}`)
      .set('x-csrf-token', pm.csrf)
      .send({ settings: { cati: { callingHours: { from: '25:00', to: '20:00' } } } });
    expect(bad.status).toBe(400);
  });
});
