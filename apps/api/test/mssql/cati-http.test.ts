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

/**
 * Telephone interviewing over HTTP on SQL Server, the counterpart of test/cati.test.ts: the call
 * queue and its locks, outcomes and retries, callbacks inside calling hours, and the last attempt.
 */
describe.skipIf(!configured)('SQL Server: telephone interviewing over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
  });
  afterAll(async () => {
    await t?.close();
  });

  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  /** A project of its own per test, with all-day calling hours unless given. */
  async function setup(cati: object = {}) {
    const project = await createProject(t.owner, tenant.id);
    const qid = await createQuestionnaire(t.owner, tenant.id, project, {
      definition,
      publish: true,
    });
    const hours = (h: object) =>
      setSettings(t.owner, project, {
        assignmentMode: 'assigned',
        cati: { callingHours: h, maxAttempts: 3, ...cati },
      });
    await hours(ALL_DAY);
    await sql`UPDATE projects SET timezone = 'America/Lima' WHERE id = ${project}`.execute(t.owner);
    const users: TestUser[] = [];
    const sessions: Session[] = [];
    for (let i = 0; i < 2; i++) {
      const u = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
      users.push(u);
      sessions.push(await login(t, u, tenant.slug));
    }
    async function mkCase(
      holder: string | null,
      x: { priority?: number; timezone?: string; phone?: boolean } = {},
    ) {
      const id = await newCase(t.owner, tenant.id, project, {
        holder,
        sample: { city: 'Lima', ...(x.timezone ? { timezone: x.timezone } : {}) },
      });
      if (x.priority)
        await sql`UPDATE cases SET priority = ${x.priority} WHERE id = ${id}`.execute(t.owner);
      if (x.phone !== false) await newContact(t.owner, tenant.id, id);
      return id;
    }
    return { project, qid, users, sessions, newCase: mkCase, hours };
  }

  it('serves cases best first, locks them, and says why when there is none', async () => {
    const { project, users, sessions, newCase: mk } = await setup();
    const [u] = users;
    const [me] = sessions;
    const low = await mk(u!.id);
    const high = await mk(u!.id, { priority: 5 });
    await mk(u!.id, { phone: false });
    await mk(u!.id, { timezone: 'Asia/Tokyo' }); // all day: still eligible

    const a = await post(me!, `/projects/${project}/cati/next`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.case.id).toBe(high);
    expect(a.body.phones).toEqual([
      expect.objectContaining({ value: '+51987654321', label: 'Móvil' }),
    ]);
    expect(a.body.scripts.intro).toEqual([{ id: 'HELLO', text: 'Buenos días, llamo a Lima.' }]);
    expect(a.body.scripts.outcomes.refusal[0].text).toBe('Gracias por su tiempo.');
    // Showing the numbers is recorded once per case (K5).
    const [views] = await rows(
      sql`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'case.pii_viewed' AND target_id = ${high}`,
    );
    expect(Number(views!.n)).toBe(1);
    // Asking again returns the same open call.
    const again = await post(me!, `/projects/${project}/cati/next`);
    expect(again.body.attempt.id).toBe(a.body.attempt.id);
    const [locked] = await rows(sql`SELECT call_lock_user_id FROM cases WHERE id = ${high}`);
    expect((locked!.call_lock_user_id as string).toLowerCase()).toBe(u!.id);

    expect((await post(me!, `/cati/attempts/${a.body.attempt.id}/release`)).status).toBe(200);
    const b = await post(me!, `/projects/${project}/cati/next`);
    expect(b.body.case.id).toBe(high); // a release is not an attempt
    expect(
      (await post(me!, `/cati/attempts/${b.body.attempt.id}/outcome`, { outcome: 'wrong_number' }))
        .status,
    ).toBe(200);
    const c = await post(me!, `/projects/${project}/cati/next`);
    expect(c.body.case.id).toBe(low);
  });

  it('schedules retries, finalises after the last attempt, and books callbacks in hours', async () => {
    const { project, users, sessions, newCase: mk, hours } = await setup();
    const [u] = users;
    const [me] = sessions;
    const caseId = await mk(u!.id);
    const a = await post(me!, `/projects/${project}/cati/next`);
    const phone = a.body.phones[0].id;
    const busy = await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
      outcome: 'busy',
      contactId: phone,
      note: 'Ocupado',
    });
    expect(busy.body).toMatchObject({ disposition: 'BUSY', final: false });
    const [row] = await rows(
      sql`SELECT attempts, disposition, next_contact_at, call_lock_user_id FROM cases WHERE id = ${caseId}`,
    );
    expect(row).toMatchObject({ attempts: 1, disposition: 'BUSY', call_lock_user_id: null });
    expect(new Date(row!.next_contact_at as Date).getTime()).toBeGreaterThan(
      Date.now() + 14 * 60_000,
    );
    const [att] = await rows(
      sql`SELECT number_masked, outcome FROM call_attempts WHERE id = ${a.body.attempt.id}`,
    );
    expect(att).toMatchObject({ number_masked: '••4321', outcome: 'busy' });
    // Not due yet.
    const none = await post(me!, `/projects/${project}/cati/next`);
    expect(none.status).toBe(204);
    expect(none.headers['x-queue-reason']).toBe('empty');
    expect(none.headers['x-next-callback']).toBeDefined();
    // A recorded call cannot change.
    expect(
      (await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, { outcome: 'refusal' }))
        .status,
    ).toBe(409);
    await expect(
      sql`UPDATE call_attempts SET note = 'x' WHERE id = ${a.body.attempt.id}`.execute(t.owner),
    ).rejects.toThrow(/cannot change/);

    // Callbacks: outside the respondent's hours is refused, inside is booked.
    await sql`UPDATE cases SET next_contact_at = NULL WHERE id = ${caseId}`.execute(t.owner);
    await sql`UPDATE cases SET sample = ${JSON.stringify({ city: 'Lima', timezone: 'UTC' })} WHERE id = ${caseId}`.execute(
      t.owner,
    );
    const b = await post(me!, `/projects/${project}/cati/next`);
    await hours({ from: '09:00', to: '21:00' });
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
    const cbs = await get(me!, `/projects/${project}/cati/callbacks`);
    expect(cbs.body).toEqual([
      expect.objectContaining({ caseId, mine: true, timezone: 'UTC', at: at(10) }),
    ]);

    // The last allowed attempt without contact ends the case.
    await sql`UPDATE cases SET next_contact_at = NULL, disposition = NULL, attempts = 2 WHERE id = ${caseId}`.execute(
      t.owner,
    );
    await hours(ALL_DAY);
    const c = await post(me!, `/projects/${project}/cati/next`);
    const last = await post(me!, `/cati/attempts/${c.body.attempt.id}/outcome`, {
      outcome: 'no_answer',
    });
    expect(last.body).toMatchObject({ disposition: 'NON_CONTACT', final: true });
    const [fin] = await rows(sql`SELECT status, disposition FROM cases WHERE id = ${caseId}`);
    expect(fin).toMatchObject({ status: 'finalised', disposition: 'NON_CONTACT' });
    const calls = await get(me!, `/projects/${project}/cases/${caseId}/calls`);
    expect(calls.body.map((x: { outcome: string }) => x.outcome)).toEqual([
      'no_answer',
      'appointment',
      'busy',
    ]);
  });

  it('lists callbacks with who booked them, and calls one now within the queue rules', async () => {
    const { project, users, sessions, newCase: mk } = await setup();
    const [u] = users;
    const [me, other] = sessions;
    const first = await mk(u!.id, { priority: 5, timezone: 'UTC' });
    await mk(u!.id);
    const a = await post(me!, `/projects/${project}/cati/next`);
    expect(a.body.case.id).toBe(first);
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (
        await post(me!, `/cati/attempts/${a.body.attempt.id}/outcome`, {
          outcome: 'callback',
          callbackAt: inAnHour,
          callbackFor: 'me',
          note: 'Llamar después del almuerzo',
        })
      ).status,
    ).toBe(200);

    const list = await get(me!, `/projects/${project}/cati/callbacks`);
    expect(list.status).toBe(200);
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
    void randomUUID;
  });
});
