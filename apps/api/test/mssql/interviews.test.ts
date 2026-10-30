import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CasesStore } from '../../src/cases/cases-store.mssql.js';
import { CatiStore } from '../../src/cati/cati-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { InterviewsStore } from '../../src/interviews/interviews-store.mssql.js';
import { QuestionnaireStore } from '../../src/questionnaires/questionnaire-store.mssql.js';

/**
 * Interviews and CATI on SQL Server (mssql/0005): starting on a case, numbered changes replayed
 * safely, the snapshot under a row lock, the append-only history, the call queue and its locks,
 * call attempts, expiry, and isolation by organisation. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: interviews and CATI', () => {
  let app: MssqlDatabase;
  const interviews = new InterviewsStore();
  const cati = new CatiStore();
  const cases = new CasesStore();
  const questionnaires = new QuestionnaireStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `ia-${stamp}`, project: randomUUID() };
  const b = { id: randomUUID(), slug: `ib-${stamp}`, project: randomUUID() };
  const me = randomUUID();
  const other = randomUUID();
  let versionId: string;
  let questionnaireId: string;

  const owner = async <T>(
    fn: (db: ReturnType<typeof createMssqlDb<Record<string, never>>>) => Promise<T>,
  ) => {
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      return await fn(db);
    } finally {
      await db.destroy();
    }
  };

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 8 });
    await owner(async (db) => {
      for (const x of [a, b]) {
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${x.id}, ${x.slug}, ${x.slug})`.execute(
          db,
        );
        await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${x.project}, ${x.id}, 'P', ${'P-' + x.slug})`.execute(
          db,
        );
      }
      for (const [i, id] of [me, other].entries())
        await sql`INSERT INTO users (id, tenant_id, email, name) VALUES (${id}, ${a.id}, ${`i${i}-${stamp}@example.org`}, ${`I${i}`})`.execute(
          db,
        );
    });
    questionnaireId = await app.withTenant(a.id, (tx) =>
      questionnaires.create(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Q',
        draft: { title: 'Q' },
        userId: me,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      questionnaires.publish(tx, {
        tenantId: a.id,
        questionnaireId,
        definition: { title: 'Q' },
        compiled: { hash: 'h1' },
        mapping: null,
        userId: me,
      }),
    );
    versionId = await app.withTenant(a.id, async (tx) => {
      const r = await tx
        .selectFrom('questionnaire_versions')
        .select('id')
        .where('questionnaire_id', '=', questionnaireId)
        .executeTakeFirstOrThrow();
      return r.id.toLowerCase();
    });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const newCase = async (
    name: string,
    extra: Partial<Parameters<CasesStore['insertCases']>[1]['cases'][number]> = {},
  ) => {
    const [id] = await app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: a.project,
        cases: [
          {
            externalId: `${name}-${stamp}`,
            contacts: [{ type: 'phone', value: '+50255501' }],
            ...extra,
          },
        ],
      }),
    );
    return id!;
  };
  const begin = (
    caseId: string | null,
    over: { id?: string; mode?: string; device?: string } = {},
  ) =>
    app.withTenant(a.id, (tx) =>
      interviews.start(tx, {
        id: over.id ?? randomUUID(),
        tenantId: a.id,
        projectId: a.project,
        caseId,
        questionnaireVersionId: versionId,
        mode: over.mode ?? 'CATI',
        interviewerId: me,
        language: 'es',
        context: { region: 'norte' },
        deviceId: over.device ?? 'dev-1',
      }),
    );

  it('starts an interview with the id the device chose, one open per case', async () => {
    const caseId = await newCase('start');
    const id = randomUUID();
    const row = await begin(caseId, { id });
    expect(row).toMatchObject({
      status: 'in_progress',
      mode: 'CATI',
      state_version: 0,
      entry_pass: 1,
      sampled: false,
    });
    expect(row.id.toLowerCase()).toBe(id);
    expect(row.context).toEqual({ region: 'norte' });
    await expect(begin(caseId)).rejects.toSatisfy(dup);
    await expect(begin(await newCase('start2'), { id })).rejects.toSatisfy(dup);
    // Cases without a case (an open web link) are not constrained; a finished interview frees the case.
    await begin(null);
    await begin(null);
    await app.withTenant(a.id, (tx) =>
      interviews.markSubmitted(tx, id, { disposition: 'COMPLETE' }),
    );
    await begin(caseId);
    const open = await app.withTenant(a.id, (tx) => interviews.openForCase(tx, caseId));
    expect(open!.id.toLowerCase()).not.toBe(id);
  });

  it('notes a device once however many requests arrive together', async () => {
    const row = await begin(await newCase('dev'));
    const seqs = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.withTenant(a.id, (tx) =>
          interviews.touchDevice(tx, { tenantId: a.id, interviewId: row.id, deviceId: 'dev-1' }),
        ),
      ),
    );
    expect(seqs.every((s) => s === 0)).toBe(true);
    const n = await app.withTenant(a.id, (tx) =>
      tx
        .selectFrom('interview_devices')
        .select(sql<number>`COUNT(*)`.as('n'))
        .where('interview_id', '=', row.id)
        .executeTakeFirstOrThrow(),
    );
    expect(n.n).toBe(1);
  });

  const ops = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      seq: from + i,
      variable: `Q${from + i}`,
      oldValue: i % 2 ? 'antes' : null,
      newValue: i % 2 ? { code: 3 } : 'texto con "comillas" y ñ',
      at: '2026-11-02T10:00:00.000Z',
      source: 'interviewer',
      reason: i === 0 ? 'prefill' : null,
    }));

  it('drops change numbers sent again, even from requests racing each other', async () => {
    const row = await begin(await newCase('replay'));
    const send = (from: number, to: number) =>
      app.withTenant(a.id, (tx) =>
        interviews.appendAnswers(tx, {
          tenantId: a.id,
          interviewId: row.id,
          deviceId: 'dev-1',
          ops: ops(from, to),
        }),
      );
    await send(1, 3);
    await send(1, 3);
    await send(2, 5);
    await Promise.all([send(4, 8), send(4, 8), send(6, 9), send(1, 9)]);
    const history = await app.withTenant(a.id, (tx) => interviews.answerHistory(tx, row.id));
    expect(history.map((h) => h.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(history[0]).toMatchObject({
      variable: 'Q1',
      old_value: null,
      new_value: 'texto con "comillas" y ñ',
      reason: 'prefill',
    });
    expect(history[1]).toMatchObject({ old_value: 'antes', new_value: { code: 3 } });
    // The same numbers from another device are other changes.
    await app.withTenant(a.id, (tx) =>
      interviews.appendAnswers(tx, {
        tenantId: a.id,
        interviewId: row.id,
        deviceId: 'dev-2',
        ops: ops(1, 2),
      }),
    );
    expect(await app.withTenant(a.id, (tx) => interviews.answerHistory(tx, row.id))).toHaveLength(
      11,
    );
  });

  it('keeps paradata in order with its payload', async () => {
    const row = await begin(await newCase('para'));
    const send = () =>
      app.withTenant(a.id, (tx) =>
        interviews.appendParadata(tx, {
          tenantId: a.id,
          interviewId: row.id,
          deviceId: 'dev-1',
          ops: [
            {
              seq: 1,
              type: 'focus',
              at: '2026-11-02T10:00:00Z',
              monotonicMs: 12.5,
              payload: { item: 'Q1' },
            },
            { seq: 2, type: 'blur', at: '2026-11-02T10:00:05Z' },
          ],
        }),
      );
    await send();
    await send();
    const para = await app.withTenant(a.id, (tx) => interviews.paradata(tx, row.id));
    expect(para.map((p) => [p.seq, p.type, p.monotonic_ms, p.payload])).toEqual([
      [1, 'focus', 12.5, { item: 'Q1' }],
      [2, 'blur', null, {}],
    ]);
  });

  it('keeps the history append-only: no privilege for the application, a trigger for the owner', async () => {
    const row = await begin(await newCase('hist'));
    await app.withTenant(a.id, async (tx) => {
      await interviews.appendAnswers(tx, {
        tenantId: a.id,
        interviewId: row.id,
        deviceId: 'd',
        ops: ops(1, 1),
      });
      await interviews.appendParadata(tx, {
        tenantId: a.id,
        interviewId: row.id,
        deviceId: 'd',
        ops: [{ seq: 1, type: 'x', at: '2026-11-02T10:00:00Z' }],
      });
    });
    for (const table of ['interview_answer_events', 'interview_paradata'] as const) {
      await expect(
        app.withTenant(a.id, (tx) =>
          sql.raw(`UPDATE ${table} SET seq = 99 WHERE interview_id = '${row.id}'`).execute(tx),
        ),
      ).rejects.toThrow(/permission was denied/i);
      await expect(
        app.withTenant(a.id, (tx) =>
          sql.raw(`DELETE FROM ${table} WHERE interview_id = '${row.id}'`).execute(tx),
        ),
      ).rejects.toThrow(/permission was denied/i);
      await owner(async (db) => {
        await expect(
          sql.raw(`UPDATE ${table} SET seq = 99 WHERE interview_id = '${row.id}'`).execute(db),
        ).rejects.toThrow(/append-only/);
        await expect(
          sql.raw(`DELETE FROM ${table} WHERE interview_id = '${row.id}'`).execute(db),
        ).rejects.toThrow(/append-only/);
      });
    }
  });

  it('applies a snapshot under the lock, never losing a write when syncs race', async () => {
    const row = await begin(await newCase('sync'));
    await app.withTenant(a.id, (tx) =>
      interviews.touchDevice(tx, { tenantId: a.id, interviewId: row.id, deviceId: 'dev-1' }),
    );
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.withTenant(a.id, async (tx) => {
          const locked = await interviews.lock(tx, row.id);
          await interviews.finishSync(tx, {
            id: row.id,
            device: 'dev-1',
            seq: i + 1,
            touch: true,
            hasState: true,
            state: { answers: { [`V${locked!.state_version}`]: i }, cursor: i },
            position: `p${i}`,
            activeMs: 100 * (i + 1),
          });
        }),
      ),
    );
    const done = await app.withTenant(a.id, (tx) => interviews.get(tx, row.id));
    expect(done!.state_version).toBe(6);
    expect(done!.state_device).toBe('dev-1');
    expect(done!.active_ms).toBeGreaterThan(0);
    expect(
      await app.withTenant(a.id, (tx) => interviews.deviceSeq(tx, row.id, 'dev-1')),
    ).toBeGreaterThanOrEqual(1);
  });

  it('keeps the codes given to "other" texts only while the text is the same', async () => {
    const row = await begin(await newCase('other'));
    await app.withTenant(a.id, (tx) =>
      interviews.touchDevice(tx, { tenantId: a.id, interviewId: row.id, deviceId: 'dev-1' }),
    );
    const sync = (answers: Record<string, unknown>, seq: number) =>
      app.withTenant(a.id, async (tx) => {
        await interviews.lock(tx, row.id);
        await interviews.finishSync(tx, {
          id: row.id,
          device: 'dev-1',
          seq,
          touch: true,
          hasState: true,
          state: { answers },
        });
      });
    await sync({ P1_OTHER: 'otra cosa', P2_OTHER: { b: 1, a: 2 } }, 1);
    // The reviewer's coding is stored beside the answers.
    await owner((db) =>
      sql`UPDATE interviews SET answers = JSON_MODIFY(JSON_MODIFY(answers, '$.P1_CODE', 7), '$.P2_CODE', 9) WHERE id = ${row.id}`.execute(
        db,
      ),
    );
    await sync({ P1_OTHER: 'otra cosa', P2_OTHER: { a: 2, b: 1 }, P3: 1 }, 2);
    let r = await app.withTenant(a.id, (tx) => interviews.get(tx, row.id));
    expect(r!.answers).toMatchObject({ P1_CODE: 7, P2_CODE: 9, P3: 1 });
    await sync({ P1_OTHER: 'cambiada', P2_OTHER: { a: 2, b: 1 } }, 3);
    r = await app.withTenant(a.id, (tx) => interviews.get(tx, row.id));
    expect(r!.answers.P1_CODE).toBeUndefined();
    expect(r!.answers.P2_CODE).toBe(9);
  });

  it('submits once: status, disposition, count, flags', async () => {
    const row = await begin(await newCase('submit'));
    await app.withTenant(a.id, (tx) =>
      interviews.markSubmitted(tx, row.id, {
        disposition: 'COMPLETE',
        flags: { speeding: true },
        sampled: true,
      }),
    );
    const r = await app.withTenant(a.id, (tx) => interviews.get(tx, row.id));
    expect(r).toMatchObject({
      status: 'submitted',
      disposition: 'COMPLETE',
      submissions: 1,
      sampled: true,
    });
    expect(r!.flags).toEqual({ speeding: true });
    expect(r!.submitted_at).toBeInstanceOf(Date);
    expect(r!.ended_at).toBeInstanceOf(Date);
  });

  describe('CATI', () => {
    const stage = async (
      name: string,
      over: {
        assignedTo?: string | null;
        attempts?: number;
        phone?: boolean;
        priority?: number;
      } = {},
    ) => {
      const id = await newCase(name, {
        priority: over.priority ?? 0,
        contacts: over.phone === false ? [{ type: 'email', value: 'x@example.org' }] : undefined,
      });
      const assignedTo = over.assignedTo === undefined ? me : over.assignedTo;
      await owner((db) =>
        sql`UPDATE cases SET status = 'assigned', assigned_to = ${assignedTo}, attempts = ${over.attempts ?? 0} WHERE id = ${id}`.execute(
          db,
        ),
      );
      return id;
    };
    const queue = (pool = false) =>
      app.withTenant(a.id, (tx) =>
        cati.candidates(tx, { projectId: a.project, userId: me, pool, maxAttempts: 3, limit: 50 }),
      );

    it('lists callable cases best first, leaving out those that cannot be called', async () => {
      const prefix = `q${stamp}`;
      const fresh = await stage(`${prefix}-fresh`, { priority: 1 });
      const tried = await stage(`${prefix}-tried`, { attempts: 1, priority: 9 });
      const callback = await stage(`${prefix}-callback`, { attempts: 5 });
      await owner((db) =>
        sql`UPDATE cases SET disposition = 'CALLBACK', next_contact_at = DATEADD(minute, -5, SYSDATETIMEOFFSET()) WHERE id = ${callback}`.execute(
          db,
        ),
      );
      const exhausted = await stage(`${prefix}-exhausted`, { attempts: 3 });
      const noPhone = await stage(`${prefix}-nophone`, { phone: false });
      const later = await stage(`${prefix}-later`);
      await owner((db) =>
        sql`UPDATE cases SET next_contact_at = DATEADD(hour, 2, SYSDATETIMEOFFSET()) WHERE id = ${later}`.execute(
          db,
        ),
      );
      const lockedByOther = await stage(`${prefix}-locked`);
      await owner((db) =>
        sql`UPDATE cases SET call_lock_user_id = ${other}, call_lock_until = DATEADD(minute, 5, SYSDATETIMEOFFSET()) WHERE id = ${lockedByOther}`.execute(
          db,
        ),
      );
      const checkedOut = await stage(`${prefix}-device`);
      await owner((db) =>
        sql`UPDATE cases SET checked_out_device = 'tablet' WHERE id = ${checkedOut}`.execute(db),
      );
      const faceToFace = await stage(`${prefix}-capi`);
      await begin(faceToFace, { mode: 'CAPI' });
      const notMine = await stage(`${prefix}-notmine`, { assignedTo: other });
      const free = await stage(`${prefix}-free`, { assignedTo: null });

      const mine = (rows: { id: string }[]) =>
        rows
          .map((r) => r.id)
          .filter((id) =>
            [
              fresh,
              tried,
              callback,
              exhausted,
              noPhone,
              later,
              lockedByOther,
              checkedOut,
              faceToFace,
              notMine,
              free,
            ].includes(id),
          );
      expect(mine(await queue())).toEqual([callback, fresh, tried]);
      expect(mine(await queue(true))).toEqual([callback, fresh, free, tried]);
    });

    it('lets one caller lock a case at a time, and the same caller again', async () => {
      const id = await stage(`lock-${stamp}`);
      const lock = (user: string) =>
        app.withTenant(a.id, (tx) => cati.lockCase(tx, id, user, 60_000));
      const results = await Promise.all([lock(me), lock(other)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? me : other;
      expect(await lock(winner)).toBe(true);
      expect(await lock(winner === me ? other : me)).toBe(false);
    });

    it('serialises one caller’s requests so they never hold two open calls', async () => {
      const id = await stage(`once-${stamp}`);
      await Promise.all(
        Array.from({ length: 5 }, () =>
          app.withTenant(a.id, async (tx) => {
            await cati.lockUserQueue(tx, a.project, other);
            const open = await cati.openAttempt(tx, a.project, other);
            if (!open)
              await cati.startCall(tx, {
                tenantId: a.id,
                projectId: a.project,
                caseId: id,
                interviewerId: other,
              });
          }),
        ),
      );
      const open = await app.withTenant(a.id, (tx) =>
        tx
          .selectFrom('call_attempts')
          .select(sql<number>`COUNT(*)`.as('n'))
          .where('interviewer_id', '=', other)
          .where('ended_at', 'is', null)
          .executeTakeFirstOrThrow(),
      );
      expect(open.n).toBe(1);
    });

    it('records a call, counts it on the case, and then no longer lets it change', async () => {
      const id = await stage(`call-${stamp}`);
      const attempt = await app.withTenant(a.id, async (tx) => {
        await cati.lockCase(tx, id, me, 60_000);
        return cati.startCall(tx, {
          tenantId: a.id,
          projectId: a.project,
          caseId: id,
          interviewerId: me,
          numberMasked: '***501',
        });
      });
      expect(
        (await app.withTenant(a.id, (tx) => cati.openAttempt(tx, a.project, me)))!.id.toLowerCase(),
      ).toBe(attempt);
      const callbackAt = new Date(Date.now() + 3_600_000);
      await app.withTenant(a.id, async (tx) => {
        await cati.lockAttempt(tx, attempt);
        await cati.closeAttempt(tx, attempt, {
          outcome: 'callback',
          disposition: 'CALLBACK',
          connectedMs: 4000,
          wrapUpMs: 900,
          callbackAt,
          note: 'Llamar tras el almuerzo',
        });
        await cati.recordCallOnCase(tx, id, {
          countAttempt: true,
          disposition: 'CALLBACK',
          nextContactAt: callbackAt,
          callbackUserId: me,
        });
      });
      const c = await app.withTenant(a.id, (tx) => cases.get(tx, a.project, id));
      expect(c).toMatchObject({
        attempts: 1,
        disposition: 'CALLBACK',
        call_lock_user_id: null,
        call_lock_until: null,
        status: 'assigned',
      });
      expect(c!.next_contact_at!.getTime()).toBe(callbackAt.getTime());
      expect(c!.callback_user_id?.toLowerCase()).toBe(me);
      expect(c!.last_attempt_at).toBeInstanceOf(Date);
      const list = await app.withTenant(a.id, (tx) => cati.attempts(tx, id));
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ outcome: 'callback', disposition: 'CALLBACK' });
      // With a disposition the call is history.
      await expect(
        app.withTenant(a.id, (tx) =>
          cati.closeAttempt(tx, attempt, { outcome: 'answered', disposition: 'COMPLETE' }),
        ),
      ).rejects.toThrow(/cannot change/);
      await expect(
        app.withTenant(a.id, (tx) =>
          sql`DELETE FROM call_attempts WHERE id = ${attempt}`.execute(tx),
        ),
      ).rejects.toThrow(/permission was denied/i);
      await owner(async (db) => {
        await expect(
          sql`DELETE FROM call_attempts WHERE id = ${attempt}`.execute(db),
        ).rejects.toThrow(/cannot change/);
      });
    });

    it('breaks off an open interview, and a final outcome finalises the case', async () => {
      const id = await stage(`final-${stamp}`);
      const row = await begin(id);
      await app.withTenant(a.id, async (tx) => {
        await cati.breakOff(tx, row.id, 'BREAK_OFF');
        await cati.recordCallOnCase(tx, id, {
          countAttempt: true,
          disposition: 'BREAK_OFF',
          finalise: true,
          nextContactAt: new Date(),
        });
      });
      const [i, c] = await app.withTenant(
        a.id,
        async (tx) =>
          [await interviews.get(tx, row.id), await cases.get(tx, a.project, id)] as const,
      );
      expect(i).toMatchObject({ status: 'broken_off', disposition: 'BREAK_OFF' });
      expect(c).toMatchObject({
        status: 'finalised',
        disposition: 'BREAK_OFF',
        next_contact_at: null,
      });
      // An interview already submitted is left as it is.
      const done = await begin(await newCase(`done-${stamp}`));
      await app.withTenant(a.id, (tx) =>
        interviews.markSubmitted(tx, done.id, { disposition: 'COMPLETE' }),
      );
      await app.withTenant(a.id, (tx) => cati.breakOff(tx, done.id, 'BREAK_OFF'));
      expect((await app.withTenant(a.id, (tx) => interviews.get(tx, done.id)))!.status).toBe(
        'submitted',
      );
    });
  });

  it('expires overdue cases, leaving those downloaded, locked or being interviewed', async () => {
    const project = randomUUID();
    await owner((db) =>
      sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${project}, ${a.id}, 'Exp', ${'EX-' + stamp})`.execute(
        db,
      ),
    );
    const ids = await app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: project,
        cases: ['old', 'recent', 'device', 'locked', 'open'].map((n) => ({ externalId: n })),
      }),
    );
    const [old, recent, device, locked, open] = ids as [string, string, string, string, string];
    await owner(async (db) => {
      for (const id of ids)
        await sql`UPDATE cases SET status = 'assigned', assigned_to = ${me}, assigned_at = DATEADD(day, ${id === recent ? -1 : -10}, SYSDATETIMEOFFSET()) WHERE id = ${id}`.execute(
          db,
        );
      await sql`UPDATE cases SET checked_out_device = 'tablet' WHERE id = ${device}`.execute(db);
      await sql`UPDATE cases SET call_lock_user_id = ${other}, call_lock_until = DATEADD(minute, 5, SYSDATETIMEOFFSET()) WHERE id = ${locked}`.execute(
        db,
      );
    });
    await app.withTenant(a.id, (tx) =>
      interviews.start(tx, {
        id: randomUUID(),
        tenantId: a.id,
        projectId: project,
        caseId: open,
        questionnaireVersionId: versionId,
        mode: 'CAPI',
        interviewerId: me,
        language: 'es',
        context: {},
        deviceId: 'd',
      }),
    );
    const expired = await app.withTenant(a.id, (tx) =>
      cases.expireOverdue(tx, { projectId: project, days: 7 }),
    );
    expect(expired.map((e) => e.id)).toEqual([old]);
    expect(expired[0]!.assignedTo).toBe(me);
    const states = await app.withTenant(a.id, (tx) =>
      cases.list(tx, { projectId: project }, { limit: 10 }),
    );
    expect(
      Object.fromEntries(states.map((c) => [c.external_id, c.disposition ?? c.status])),
    ).toEqual({
      old: 'EXPIRED',
      recent: 'assigned',
      device: 'assigned',
      locked: 'assigned',
      open: 'assigned',
    });
  });

  it('shows another organisation nothing, and refuses its writes', async () => {
    const row = await begin(await newCase('iso'));
    expect(await app.withTenant(b.id, (tx) => interviews.get(tx, row.id))).toBeUndefined();
    expect(
      await app.withTenant(b.id, (tx) =>
        cati.candidates(tx, {
          projectId: a.project,
          userId: me,
          pool: true,
          maxAttempts: 3,
          limit: 5,
        }),
      ),
    ).toEqual([]);
    await expect(
      app.withTenant(b.id, (tx) =>
        interviews.start(tx, {
          id: randomUUID(),
          tenantId: a.id,
          projectId: a.project,
          caseId: null,
          questionnaireVersionId: versionId,
          mode: 'CATI',
          interviewerId: me,
          language: 'es',
          context: {},
          deviceId: 'd',
        }),
      ),
    ).rejects.toThrow();
  });
});
