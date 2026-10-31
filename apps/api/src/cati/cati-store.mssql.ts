import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';
import { idOrder } from '../db/mssql/order.js';

/**
 * CATI on SQL Server (Kysely): the call queue's candidates, the lock on the case being called,
 * call attempts and what a call does to its case, as `cati.service.ts` does them on PostgreSQL
 * with Drizzle (docs/roadmap.md). The rules (calling hours, retries, outcomes) stay in the
 * service; this is the data access. Takes the transaction of `MssqlDatabase.withTenant`.
 */
export type CaseRow = Selectable<MssqlSchema['cases']>;
export type AttemptRow = Selectable<MssqlSchema['call_attempts']>;

export interface QueueQuery {
  projectId: string;
  userId: string;
  /** The questionnaire being called: its cases and those of no questionnaire. */
  questionnaireId?: string;
  /** Pool mode: cases nobody holds can be called too. */
  pool: boolean;
  maxAttempts: number;
  limit: number;
}

export class CatiStore {
  /**
   * One request at a time per caller and project, so a caller never holds two open calls: an
   * application lock owned by the transaction (PostgreSQL's pg_advisory_xact_lock).
   */
  async lockUserQueue(tx: MssqlTx, projectId: string, userId: string): Promise<void> {
    await sql`
      DECLARE @r int;
      EXEC @r = sp_getapplock @Resource = ${`cati:${projectId}:${userId}`}, @LockMode = N'Exclusive',
        @LockOwner = N'Transaction', @LockTimeout = 30000;
      IF @r < 0 THROW 50040, 'Could not take the call queue lock', 1;`.execute(tx);
  }

  /**
   * The cases a person can call now, best first: a booked callback, one for them, one never
   * called, higher priority, longest without a call. The same conditions as the PostgreSQL queue:
   * callable status and mode, held by the person (or free in pool mode), not locked by someone
   * else, due, attempts left (or a callback), a valid phone, an active questionnaire, not downloaded
   * to a device and not being interviewed face to face.
   */
  async candidates(tx: MssqlTx, q: QueueQuery): Promise<CaseRow[]> {
    const res = await sql<CaseRow>`
      SELECT TOP (${q.limit}) c.* FROM dbo.cases c
      WHERE c.project_id = ${q.projectId}
        ${q.questionnaireId ? sql`AND (c.questionnaire_id = ${q.questionnaireId} OR c.questionnaire_id IS NULL)` : sql``}
        AND c.status IN ('fresh', 'assigned', 'in_progress')
        AND (c.mode_preference IS NULL OR c.mode_preference = 'CATI')
        AND ${q.pool ? sql`(c.assigned_to = ${q.userId} OR c.assigned_to IS NULL)` : sql`c.assigned_to = ${q.userId}`}
        AND (c.call_lock_until IS NULL OR c.call_lock_until < SYSDATETIMEOFFSET() OR c.call_lock_user_id = ${q.userId})
        AND (c.next_contact_at IS NULL OR c.next_contact_at <= SYSDATETIMEOFFSET())
        AND (c.attempts < ${q.maxAttempts} OR c.disposition = 'CALLBACK')
        AND EXISTS (SELECT 1 FROM dbo.contacts ct WHERE ct.case_id = c.id AND ct.type = 'phone' AND ct.valid = 1)
        AND NOT EXISTS (SELECT 1 FROM dbo.questionnaires qq WHERE qq.id = c.questionnaire_id AND qq.state <> 'active')
        AND c.checked_out_device IS NULL
        AND NOT EXISTS (SELECT 1 FROM dbo.interviews iv WHERE iv.case_id = c.id AND iv.status = 'in_progress' AND iv.mode <> 'CATI')
      ORDER BY
        CASE WHEN c.disposition = 'CALLBACK' AND c.next_contact_at IS NOT NULL THEN 1 ELSE 0 END DESC,
        CASE WHEN c.callback_user_id = ${q.userId} THEN 1 ELSE 0 END DESC,
        CASE WHEN c.attempts = 0 THEN 1 ELSE 0 END DESC,
        c.priority DESC,
        c.last_attempt_at ASC,
        c.created_at,
        c.id`.execute(tx);
    return res.rows.map((r) => ({ ...r, id: r.id.toLowerCase() }));
  }

  /**
   * Locks the case for the caller until `until`, unless someone else holds a lock that has not
   * run out. Returns whether the caller got it. Skips cases other callers are locking (READPAST), so
   * two callers choosing at once end with different cases.
   */
  async lockCase(tx: MssqlTx, caseId: string, userId: string, ms: number): Promise<boolean> {
    const res = await sql<{ id: string }>`
      UPDATE c SET call_lock_user_id = ${userId},
        call_lock_until = DATEADD(millisecond, ${ms}, SYSDATETIMEOFFSET())
      OUTPUT inserted.id
      FROM dbo.cases c WITH (UPDLOCK, READPAST, ROWLOCK)
      WHERE c.id = ${caseId}
        AND (c.call_lock_until IS NULL OR c.call_lock_until < SYSDATETIMEOFFSET() OR c.call_lock_user_id = ${userId})`.execute(
      tx,
    );
    return res.rows.length > 0;
  }

  async startCall(
    tx: MssqlTx,
    v: {
      tenantId: string;
      projectId: string;
      caseId: string;
      interviewerId: string;
      contactId?: string | null;
      numberMasked?: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('call_attempts')
      .values({
        id,
        tenant_id: v.tenantId,
        project_id: v.projectId,
        case_id: v.caseId,
        interviewer_id: v.interviewerId,
        contact_id: v.contactId ?? null,
        number_masked: v.numberMasked ?? null,
        ended_at: null,
        connected_ms: null,
        wrap_up_ms: null,
        outcome: null,
        disposition: null,
        callback_at: null,
        note: null,
        interview_id: null,
      })
      .execute();
    return id;
  }

  /** The call the person has open (started, not ended), if any. */
  async openAttempt(
    tx: MssqlTx,
    projectId: string,
    userId: string,
  ): Promise<AttemptRow | undefined> {
    return tx
      .selectFrom('call_attempts')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('interviewer_id', '=', userId)
      .where('ended_at', 'is', null)
      .where('outcome', 'is', null)
      .orderBy('started_at', 'desc')
      .top(1)
      .executeTakeFirst();
  }

  /** The attempt with a row lock, for the rest of the transaction. */
  async lockAttempt(tx: MssqlTx, id: string): Promise<AttemptRow | undefined> {
    const res =
      await sql<AttemptRow>`SELECT * FROM dbo.call_attempts WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`.execute(
        tx,
      );
    return res.rows[0];
  }

  /** Records how the call went; a call that already has a disposition cannot be changed. */
  async closeAttempt(
    tx: MssqlTx,
    id: string,
    v: {
      outcome: string;
      disposition: string;
      connectedMs?: number | null;
      wrapUpMs?: number | null;
      callbackAt?: Date | null;
      note?: string | null;
      interviewId?: string | null;
    },
  ): Promise<void> {
    await tx
      .updateTable('call_attempts')
      .set({
        outcome: v.outcome,
        disposition: v.disposition,
        ended_at: sql<Date>`SYSDATETIMEOFFSET()`,
        connected_ms: v.connectedMs ?? null,
        wrap_up_ms: v.wrapUpMs ?? null,
        callback_at: v.callbackAt ?? null,
        note: v.note ?? null,
        interview_id: v.interviewId ?? null,
      })
      .where('id', '=', id)
      .execute();
  }

  async attempts(tx: MssqlTx, caseId: string) {
    return tx
      .selectFrom('call_attempts')
      .select([
        'id',
        'interviewer_id',
        'started_at',
        'ended_at',
        'outcome',
        'disposition',
        'callback_at',
      ])
      .where('case_id', '=', caseId)
      .orderBy('started_at')
      .orderBy(idOrder)
      .execute();
  }

  /**
   * What a finished call does to its case: one more attempt, the time of it, the disposition and
   * status the service decided, when to call next, who the callback is for, and the lock released.
   */
  async recordCallOnCase(
    tx: MssqlTx,
    caseId: string,
    v: {
      countAttempt: boolean;
      disposition?: string | null;
      finalise?: boolean;
      nextContactAt?: Date | null;
      callbackUserId?: string | null;
    },
  ): Promise<void> {
    await tx
      .updateTable('cases')
      .set({
        ...(v.countAttempt
          ? { attempts: sql<number>`attempts + 1`, last_attempt_at: sql<Date>`SYSDATETIMEOFFSET()` }
          : {}),
        ...(v.disposition !== undefined ? { disposition: v.disposition } : {}),
        ...(v.finalise ? { status: 'finalised' } : {}),
        next_contact_at: v.finalise ? null : (v.nextContactAt ?? null),
        callback_user_id: v.callbackUserId ?? null,
        call_lock_user_id: null,
        call_lock_until: null,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', caseId)
      .execute();
  }

  /** An interview cut short by a final outcome: broken off, if it is still open. */
  async breakOff(tx: MssqlTx, interviewId: string, disposition: string): Promise<void> {
    await tx
      .updateTable('interviews')
      .set({
        status: 'broken_off',
        disposition,
        ended_at: sql<Date>`SYSDATETIMEOFFSET()`,
        updated_at: sql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', interviewId)
      .where('status', '=', 'in_progress')
      .execute();
  }
}
