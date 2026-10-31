import { Injectable } from '@nestjs/common';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  MssqlInterviewsTx,
  toCase,
  type CaseFull,
  type InterviewRow,
  type InterviewsTx,
} from '../interviews/interviews-repo.js';
import { InterviewsStore } from '../interviews/interviews-store.mssql.js';
import { CatiStore } from './cati-store.mssql.js';
import { idOrder } from '../db/mssql/order.js';

/**
 * The database side of telephone interviewing, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also an `InterviewsTx`.
 */
export interface AttemptRow {
  id: string;
  tenantId: string;
  projectId: string;
  caseId: string;
  interviewerId: string;
  contactId: string | null;
  numberMasked: string | null;
  startedAt: Date;
  endedAt: Date | null;
  connectedMs: number | null;
  wrapUpMs: number | null;
  outcome: string | null;
  disposition: string | null;
  callbackAt: Date | null;
  note: string | null;
  interviewId: string | null;
}

export interface QueueFilter {
  projectId: string;
  questionnaireId?: string;
  userId: string;
  pool: boolean;
  maxAttempts: number;
  limit: number;
}

export interface CasePatch {
  attempts?: number;
  lastAttemptAt?: Date;
  callLockUserId?: string | null;
  callLockUntil?: Date | null;
  nextContactAt?: Date | null;
  callbackUserId?: string | null;
  disposition?: string | null;
  status?: string;
  updatedAt?: Date;
}

export interface AttemptPatch {
  contactId?: string;
  numberMasked?: string;
  note?: string;
  connectedMs?: number;
  wrapUpMs?: number;
  outcome?: string;
  disposition?: string;
  callbackAt?: Date | null;
  endedAt?: Date;
  interviewId?: string;
}

export interface CatiTx extends InterviewsTx {
  /** One request at a time per caller and project. */
  lockQueue(projectId: string, userId: string): Promise<void>;
  openAttempt(projectId: string, userId: string): Promise<AttemptRow | null>;
  attemptForUpdate(id: string): Promise<AttemptRow | null>;
  caseOf(id: string): Promise<CaseFull | null>;
  /** A case of the project that can be called by phone at all. */
  callable(projectId: string, caseId: string, lock: boolean): Promise<CaseFull | null>;
  /** The best eligible candidates by the SQL order. */
  candidates(f: QueueFilter): Promise<CaseFull[]>;
  /** Locks one case, skipping it when another transaction holds it. */
  lockSkipping(id: string): Promise<CaseFull | null>;
  setCallLock(caseId: string, userId: string, until: Date): Promise<void>;
  startAttempt(v: {
    projectId: string;
    caseId: string;
    interviewerId: string;
  }): Promise<AttemptRow>;
  patchCase(id: string, patch: CasePatch): Promise<void>;
  patchAttempt(id: string, patch: AttemptPatch): Promise<void>;
  /** The caller's next callback time in the project. */
  upcoming(projectId: string, userId: string): Promise<Date | null>;
  usableQuestionnaires(projectId: string): Promise<{ id: string; name: string }[]>;
  phones(caseId: string): Promise<{ id: string; value: string; label: string | null }[]>;
  attempts(caseId: string): Promise<
    {
      id: string;
      startedAt: Date;
      endedAt: Date | null;
      outcome: string | null;
      disposition: string | null;
      callbackAt: Date | null;
      numberMasked: string | null;
      connectedMs: number | null;
      note: string | null;
      interviewer: string | null;
    }[]
  >;
  contactOf(caseId: string, contactId: string): Promise<{ id: string; value: string } | null>;
  names(userId: string): Promise<{ name: string; firstName: string | null } | null>;
  breakOff(interviewId: string, disposition: string, now: Date): Promise<void>;
  /** Ends the call of the interview with its disposition and frees the case. */
  closeCallOfInterview(interview: InterviewRow, disposition: string): Promise<void>;
  /** Releases the caller's lock on a case. */
  unlock(caseId: string, userId: string): Promise<void>;
  callbacks(
    projectId: string,
    userId: string,
    pool: boolean,
  ): Promise<
    {
      c: CaseFull;
      forUserName: string | null;
      booking: { outcome: string; note: string | null; by: string | null } | null;
      phone: boolean;
      otherMode: boolean;
    }[]
  >;
}

export interface CatiRepo {
  inTenant<T>(tenantId: string, fn: (t: CatiTx) => Promise<T>): Promise<T>;
  /** This module's view of a transaction another module opened (a submit hook). */
  extend(t: InterviewsTx): CatiTx;
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());

function toAttempt(r: Record<string, unknown>): AttemptRow {
  const g = (k: string) => r[k] as never;
  const id = (k: string) => lowOrNull((r[k] as string | null) ?? null);
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    caseId: low(r.case_id as string),
    interviewerId: low(r.interviewer_id as string),
    contactId: id('contact_id'),
    numberMasked: g('number_masked'),
    startedAt: g('started_at'),
    endedAt: g('ended_at'),
    connectedMs: g('connected_ms'),
    wrapUpMs: g('wrap_up_ms'),
    outcome: g('outcome'),
    disposition: g('disposition'),
    callbackAt: g('callback_at'),
    note: g('note'),
    interviewId: id('interview_id'),
  } as unknown as AttemptRow;
}

export class MssqlCatiTx extends MssqlInterviewsTx implements CatiTx {
  constructor(
    private readonly mtx: MssqlTx,
    private readonly tn: string,
    cstore: CasesStore,
    istore: InterviewsStore,
    private readonly cati: CatiStore,
  ) {
    super(mtx, tn, cstore, istore);
  }

  lockQueue(projectId: string, userId: string) {
    return this.cati.lockUserQueue(this.mtx, projectId, userId);
  }

  async openAttempt(projectId: string, userId: string) {
    const r = await this.mtx
      .selectFrom('call_attempts')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('interviewer_id', '=', userId)
      .where('ended_at', 'is', null)
      .where('disposition', 'is', null)
      .orderBy('started_at', 'desc')
      .top(1)
      .executeTakeFirst();
    return r ? toAttempt(r as never) : null;
  }

  async attemptForUpdate(id: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT * FROM dbo.call_attempts WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`.execute(this.mtx);
    return res.rows[0] ? toAttempt(res.rows[0]) : null;
  }

  async caseOf(id: string) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases WHERE id = ${id}`.execute(this.mtx);
    return res.rows[0] ? toCase(res.rows[0]) : null;
  }

  async callable(projectId: string, caseId: string, lock: boolean) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases c ${ksql.raw(lock ? 'WITH (UPDLOCK, ROWLOCK)' : '')}
      WHERE c.id = ${caseId} AND c.project_id = ${projectId}
        AND c.status IN ('fresh', 'assigned', 'in_progress')
        AND (c.mode_preference IS NULL OR c.mode_preference = 'CATI')
        AND c.checked_out_device IS NULL
        AND EXISTS (SELECT 1 FROM dbo.contacts ct WHERE ct.case_id = c.id AND ct.type = 'phone' AND ct.valid = 1)
        AND NOT EXISTS (SELECT 1 FROM dbo.interviews iv WHERE iv.case_id = c.id
                        AND iv.status = 'in_progress' AND iv.mode <> 'CATI')`.execute(this.mtx);
    return res.rows[0] ? toCase(res.rows[0]) : null;
  }

  async candidates(f: QueueFilter) {
    const rows = await this.cati.candidates(this.mtx, f);
    return rows.map((r) => toCase(r as never));
  }

  async lockSkipping(id: string) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases WITH (UPDLOCK, READPAST, ROWLOCK) WHERE id = ${id}`.execute(this.mtx);
    return res.rows[0] ? toCase(res.rows[0]) : null;
  }

  async setCallLock(caseId: string, userId: string, until: Date) {
    await this.mtx
      .updateTable('cases')
      .set({ call_lock_user_id: userId, call_lock_until: instant(until) })
      .where('id', '=', caseId)
      .execute();
  }

  async startAttempt(v: { projectId: string; caseId: string; interviewerId: string }) {
    const id = randomUUID();
    await this.mtx
      .insertInto('call_attempts')
      .values({
        id,
        tenant_id: this.tn,
        project_id: v.projectId,
        case_id: v.caseId,
        interviewer_id: v.interviewerId,
        contact_id: null,
        number_masked: null,
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
    const r = await this.mtx
      .selectFrom('call_attempts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toAttempt(r as never);
  }

  async patchCase(id: string, p: CasePatch) {
    await this.mtx
      .updateTable('cases')
      .set({
        ...(p.attempts !== undefined ? { attempts: p.attempts } : {}),
        ...(p.lastAttemptAt ? { last_attempt_at: instant(p.lastAttemptAt) } : {}),
        ...(p.callLockUserId !== undefined ? { call_lock_user_id: p.callLockUserId } : {}),
        ...(p.callLockUntil !== undefined
          ? { call_lock_until: p.callLockUntil ? instant(p.callLockUntil) : null }
          : {}),
        ...(p.nextContactAt !== undefined
          ? { next_contact_at: p.nextContactAt ? instant(p.nextContactAt) : null }
          : {}),
        ...(p.callbackUserId !== undefined ? { callback_user_id: p.callbackUserId } : {}),
        ...(p.disposition !== undefined ? { disposition: p.disposition } : {}),
        ...(p.status ? { status: p.status } : {}),
        updated_at: p.updatedAt ? instant(p.updatedAt) : ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async patchAttempt(id: string, p: AttemptPatch) {
    await this.mtx
      .updateTable('call_attempts')
      .set({
        ...(p.contactId !== undefined ? { contact_id: p.contactId } : {}),
        ...(p.numberMasked !== undefined ? { number_masked: p.numberMasked } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
        ...(p.connectedMs !== undefined ? { connected_ms: p.connectedMs } : {}),
        ...(p.wrapUpMs !== undefined ? { wrap_up_ms: p.wrapUpMs } : {}),
        ...(p.outcome !== undefined ? { outcome: p.outcome } : {}),
        ...(p.disposition !== undefined ? { disposition: p.disposition } : {}),
        ...(p.callbackAt !== undefined
          ? { callback_at: p.callbackAt ? instant(p.callbackAt) : null }
          : {}),
        ...(p.endedAt ? { ended_at: instant(p.endedAt) } : {}),
        ...(p.interviewId !== undefined ? { interview_id: p.interviewId } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  async upcoming(projectId: string, userId: string) {
    const r = await this.mtx
      .selectFrom('cases')
      .select('next_contact_at')
      .where('project_id', '=', projectId)
      .where('next_contact_at', '>', ksql<Date>`SYSDATETIMEOFFSET()`)
      .where((eb) => eb.or([eb('callback_user_id', '=', userId), eb('assigned_to', '=', userId)]))
      .where('status', 'in', ['fresh', 'assigned', 'in_progress'])
      .orderBy('next_contact_at')
      .top(1)
      .executeTakeFirst();
    return r?.next_contact_at ?? null;
  }

  async usableQuestionnaires(projectId: string) {
    const res = await ksql<{ id: string; name: string }>`
      SELECT DISTINCT q.id, q.name FROM dbo.questionnaires q
      JOIN dbo.questionnaire_versions v ON v.questionnaire_id = q.id
      WHERE q.project_id = ${projectId} AND v.status = 'published' AND q.state = 'active'
      ORDER BY q.name`.execute(this.mtx);
    return res.rows.map((r) => ({ id: low(r.id), name: r.name }));
  }

  async phones(caseId: string) {
    const rows = await this.mtx
      .selectFrom('contacts')
      .select(['id', 'value', 'label'])
      .where('case_id', '=', caseId)
      .where('type', '=', 'phone')
      .where('valid', '=', true)
      .orderBy('created_at')
      .orderBy(idOrder)
      .execute();
    return rows.map((r) => ({ id: low(r.id), value: r.value, label: r.label }));
  }

  async attempts(caseId: string) {
    const rows = await this.mtx
      .selectFrom('call_attempts as a')
      .leftJoin('users as u', 'u.id', 'a.interviewer_id')
      .select([
        'a.id',
        'a.started_at',
        'a.ended_at',
        'a.outcome',
        'a.disposition',
        'a.callback_at',
        'a.number_masked',
        'a.connected_ms',
        'a.note',
        'u.name as interviewer',
      ])
      .where('a.case_id', '=', caseId)
      .orderBy('a.started_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      outcome: r.outcome,
      disposition: r.disposition,
      callbackAt: r.callback_at,
      numberMasked: r.number_masked,
      connectedMs: r.connected_ms,
      note: r.note,
      interviewer: r.interviewer,
    }));
  }

  async contactOf(caseId: string, contactId: string) {
    const c = await this.mtx
      .selectFrom('contacts')
      .select(['id', 'value'])
      .where('id', '=', contactId)
      .where('case_id', '=', caseId)
      .executeTakeFirst();
    return c ? { id: low(c.id), value: c.value } : null;
  }

  async names(userId: string) {
    const u = await this.mtx
      .selectFrom('users')
      .select(['name', 'first_name'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return u ? { name: u.name, firstName: u.first_name } : null;
  }

  async breakOff(interviewId: string, disposition: string, now: Date) {
    await this.mtx
      .updateTable('interviews')
      .set({
        status: 'broken_off',
        disposition,
        ended_at: instant(now),
        updated_at: instant(now),
      })
      .where('id', '=', interviewId)
      .where('status', '=', 'in_progress')
      .execute();
  }

  async closeCallOfInterview(row: InterviewRow, disposition: string) {
    await ksql`
      UPDATE dbo.call_attempts SET disposition = ${disposition}, ended_at = SYSDATETIMEOFFSET()
      WHERE interview_id = ${row.id} AND disposition IS NULL`.execute(this.mtx);
    await this.mtx
      .updateTable('cases')
      .set({
        call_lock_user_id: null,
        call_lock_until: null,
        next_contact_at: null,
        callback_user_id: null,
      })
      .where('id', '=', row.caseId!)
      .execute();
  }

  async unlock(caseId: string, userId: string) {
    await this.mtx
      .updateTable('cases')
      .set({ call_lock_user_id: null, call_lock_until: null })
      .where('id', '=', caseId)
      .where('call_lock_user_id', '=', userId)
      .execute();
  }

  async callbacks(projectId: string, userId: string, pool: boolean) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT TOP (200) c.*,
        (SELECT u.name FROM dbo.users u WHERE u.id = c.callback_user_id) AS for_user_name,
        (SELECT TOP (1) a.outcome FROM dbo.call_attempts a
          WHERE a.case_id = c.id AND a.callback_at IS NOT NULL ORDER BY a.ended_at DESC) AS b_outcome,
        (SELECT TOP (1) a.note FROM dbo.call_attempts a
          WHERE a.case_id = c.id AND a.callback_at IS NOT NULL ORDER BY a.ended_at DESC) AS b_note,
        (SELECT TOP (1) u.name FROM dbo.call_attempts a LEFT JOIN dbo.users u ON u.id = a.interviewer_id
          WHERE a.case_id = c.id AND a.callback_at IS NOT NULL ORDER BY a.ended_at DESC) AS b_by,
        CASE WHEN EXISTS (SELECT 1 FROM dbo.contacts ct WHERE ct.case_id = c.id AND ct.type = 'phone' AND ct.valid = 1) THEN 1 ELSE 0 END AS has_phone,
        CASE WHEN EXISTS (SELECT 1 FROM dbo.interviews iv WHERE iv.case_id = c.id AND iv.status = 'in_progress' AND iv.mode <> 'CATI') THEN 1 ELSE 0 END AS other_mode
      FROM dbo.cases c
      WHERE c.project_id = ${projectId} AND c.disposition = 'CALLBACK'
        AND c.status IN ('fresh', 'assigned', 'in_progress')
        AND (c.callback_user_id = ${userId}
          OR (c.callback_user_id IS NULL AND ${
            pool
              ? ksql`(c.assigned_to = ${userId} OR c.assigned_to IS NULL)`
              : ksql`c.assigned_to = ${userId}`
          }))
      ORDER BY c.next_contact_at`.execute(this.mtx);
    return res.rows.map((r) => ({
      c: toCase(r),
      forUserName: (r.for_user_name as string | null) ?? null,
      booking: r.b_outcome
        ? {
            outcome: r.b_outcome as string,
            note: (r.b_note as string | null) ?? null,
            by: (r.b_by as string | null) ?? null,
          }
        : null,
      phone: !!r.has_phone,
      otherMode: !!r.other_mode,
    }));
  }
}

@Injectable()
export class MssqlCatiRepo implements CatiRepo {
  private readonly cstore = new CasesStore();
  private readonly istore = new InterviewsStore();
  private readonly cati = new CatiStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: CatiTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlCatiTx(tx, tenantId, this.cstore, this.istore, this.cati)),
    );
  }

  extend(t: InterviewsTx): CatiTx {
    const h = t.handle();
    return new MssqlCatiTx(h.tx, h.tenantId, this.cstore, this.istore, this.cati);
  }
}

export const CATI_REPO = Symbol('CATI_REPO');
