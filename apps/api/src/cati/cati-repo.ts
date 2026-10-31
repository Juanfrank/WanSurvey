import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  callAttempts,
  cases,
  contacts,
  interviews,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import {
  MssqlInterviewsTx,
  PgInterviewsTx,
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
export type AttemptRow = typeof callAttempts.$inferSelect;

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

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

export class PgCatiTx extends PgInterviewsTx implements CatiTx {
  constructor(
    private readonly ctx: Tx,
    tenant: string,
    audits: AuditService,
  ) {
    super(ctx, tenant, audits);
  }

  async lockQueue(projectId: string, userId: string) {
    await this.ctx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cati:${projectId}:${userId}`}))`,
    );
  }

  async openAttempt(projectId: string, userId: string) {
    const [a] = await this.ctx
      .select()
      .from(callAttempts)
      .where(
        and(
          eq(callAttempts.projectId, projectId),
          eq(callAttempts.interviewerId, userId),
          isNull(callAttempts.endedAt),
          isNull(callAttempts.disposition),
        ),
      )
      .orderBy(desc(callAttempts.startedAt))
      .limit(1);
    return a ?? null;
  }

  async attemptForUpdate(id: string) {
    const [a] = await this.ctx
      .select()
      .from(callAttempts)
      .where(eq(callAttempts.id, id))
      .for('update');
    return a ?? null;
  }

  async caseOf(id: string) {
    const [c] = await this.ctx.select().from(cases).where(eq(cases.id, id));
    return c ?? null;
  }

  async callable(projectId: string, caseId: string, lock: boolean) {
    const q = this.ctx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.id, caseId),
          eq(cases.projectId, projectId),
          inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
          or(isNull(cases.modePreference), eq(cases.modePreference, 'CATI')),
          isNull(cases.checkedOutDevice),
          sql`exists (select 1 from contacts ct where ct.case_id = ${cases.id}
                and ct.type = 'phone' and ct.valid)`,
          sql`not exists (select 1 from interviews iv where iv.case_id = ${cases.id}
                and iv.status = 'in_progress' and iv.mode <> 'CATI')`,
        ),
      );
    const [c] = lock ? await q.for('update') : await q;
    return c ?? null;
  }

  candidates(f: QueueFilter) {
    return this.ctx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.projectId, f.projectId),
          // The cases of the questionnaire being called (each has its own list).
          f.questionnaireId
            ? or(eq(cases.questionnaireId, f.questionnaireId), isNull(cases.questionnaireId))
            : undefined,
          inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
          or(isNull(cases.modePreference), eq(cases.modePreference, 'CATI')),
          f.pool
            ? or(eq(cases.assignedTo, f.userId), isNull(cases.assignedTo))
            : eq(cases.assignedTo, f.userId),
          or(
            isNull(cases.callLockUntil),
            sql`${cases.callLockUntil} < now()`,
            eq(cases.callLockUserId, f.userId),
          ),
          or(isNull(cases.nextContactAt), sql`${cases.nextContactAt} <= now()`),
          or(sql`${cases.attempts} < ${f.maxAttempts}`, eq(cases.disposition, 'CALLBACK')),
          sql`exists (select 1 from contacts ct where ct.case_id = ${cases.id}
                and ct.type = 'phone' and ct.valid)`,
          // Nor the cases of a disabled or completed questionnaire.
          sql`not exists (select 1 from questionnaires qq where qq.id = ${cases.questionnaireId}
                and qq.state <> 'active')`,
          // A case downloaded to a device, or being interviewed face to face, is not called.
          isNull(cases.checkedOutDevice),
          sql`not exists (select 1 from interviews iv where iv.case_id = ${cases.id}
                and iv.status = 'in_progress' and iv.mode <> 'CATI')`,
        ),
      )
      .orderBy(
        sql`(${cases.disposition} = 'CALLBACK' and ${cases.nextContactAt} is not null) desc nulls last`,
        sql`(${cases.callbackUserId} = ${f.userId}) desc nulls last`,
        sql`(${cases.attempts} = 0) desc`,
        desc(cases.priority),
        sql`${cases.lastAttemptAt} asc nulls first`,
      )
      .limit(f.limit);
  }

  async lockSkipping(id: string) {
    const [row] = await this.ctx
      .select()
      .from(cases)
      .where(eq(cases.id, id))
      .for('update', { skipLocked: true });
    return row ?? null;
  }

  async setCallLock(caseId: string, userId: string, until: Date) {
    await this.ctx
      .update(cases)
      .set({ callLockUserId: userId, callLockUntil: until })
      .where(eq(cases.id, caseId));
  }

  async startAttempt(v: { projectId: string; caseId: string; interviewerId: string }) {
    const [a] = await this.ctx
      .insert(callAttempts)
      .values({ tenantId: this.tenantOf(), ...v })
      .returning();
    return a!;
  }

  private tenantOf() {
    return (this as unknown as { tenant: string }).tenant;
  }

  async patchCase(id: string, patch: CasePatch) {
    await this.ctx.update(cases).set(patch).where(eq(cases.id, id));
  }

  async patchAttempt(id: string, patch: AttemptPatch) {
    await this.ctx.update(callAttempts).set(patch).where(eq(callAttempts.id, id));
  }

  async upcoming(projectId: string, userId: string) {
    const [n] = await this.ctx
      .select({ at: cases.nextContactAt })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          gt(cases.nextContactAt, new Date()),
          or(eq(cases.callbackUserId, userId), eq(cases.assignedTo, userId)),
          inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
        ),
      )
      .orderBy(asc(cases.nextContactAt))
      .limit(1);
    return n?.at ?? null;
  }

  usableQuestionnaires(projectId: string) {
    return this.ctx
      .selectDistinct({ id: questionnaires.id, name: questionnaires.name })
      .from(questionnaires)
      .innerJoin(
        questionnaireVersions,
        eq(questionnaireVersions.questionnaireId, questionnaires.id),
      )
      .where(
        and(
          eq(questionnaires.projectId, projectId),
          eq(questionnaireVersions.status, 'published'),
          eq(questionnaires.state, 'active'),
        ),
      )
      .orderBy(asc(questionnaires.name));
  }

  phones(caseId: string) {
    return this.ctx
      .select({ id: contacts.id, value: contacts.value, label: contacts.label })
      .from(contacts)
      .where(and(eq(contacts.caseId, caseId), eq(contacts.type, 'phone'), eq(contacts.valid, true)))
      .orderBy(asc(contacts.createdAt));
  }

  attempts(caseId: string) {
    return this.ctx
      .select({
        id: callAttempts.id,
        startedAt: callAttempts.startedAt,
        endedAt: callAttempts.endedAt,
        outcome: callAttempts.outcome,
        disposition: callAttempts.disposition,
        callbackAt: callAttempts.callbackAt,
        numberMasked: callAttempts.numberMasked,
        connectedMs: callAttempts.connectedMs,
        note: callAttempts.note,
        interviewer: users.name,
      })
      .from(callAttempts)
      .leftJoin(users, eq(users.id, callAttempts.interviewerId))
      .where(eq(callAttempts.caseId, caseId))
      .orderBy(desc(callAttempts.startedAt));
  }

  async contactOf(caseId: string, contactId: string) {
    const [c] = await this.ctx
      .select({ id: contacts.id, value: contacts.value })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.caseId, caseId)));
    return c ?? null;
  }

  async names(userId: string) {
    const [me] = await this.ctx
      .select({ name: users.name, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, userId));
    return me ?? null;
  }

  async breakOff(interviewId: string, disposition: string, now: Date) {
    await this.ctx
      .update(interviews)
      .set({ status: 'broken_off', disposition, endedAt: now, updatedAt: now })
      .where(and(eq(interviews.id, interviewId), eq(interviews.status, 'in_progress')));
  }

  async closeCallOfInterview(row: InterviewRow, disposition: string) {
    await this.ctx
      .update(callAttempts)
      .set({ disposition, endedAt: new Date() })
      .where(and(eq(callAttempts.interviewId, row.id), isNull(callAttempts.disposition)));
    await this.ctx
      .update(cases)
      .set({ callLockUserId: null, callLockUntil: null, nextContactAt: null, callbackUserId: null })
      .where(eq(cases.id, row.caseId!));
  }

  async unlock(caseId: string, userId: string) {
    await this.ctx
      .update(cases)
      .set({ callLockUserId: null, callLockUntil: null })
      .where(and(eq(cases.id, caseId), eq(cases.callLockUserId, userId)));
  }

  async callbacks(projectId: string, userId: string, pool: boolean) {
    const forUser = sql<
      string | null
    >`(select u.name from users u where u.id = cases.callback_user_id)`;
    const booking = sql<{ outcome: string; note: string | null; by: string | null } | null>`(
      select json_build_object('outcome', a.outcome, 'note', a.note, 'by', u.name)
        from call_attempts a left join users u on u.id = a.interviewer_id
       where a.case_id = cases.id and a.callback_at is not null
       order by a.ended_at desc nulls last limit 1)`;
    const rows = await this.ctx
      .select({
        c: cases,
        forUserName: forUser,
        booking,
        phone: sql<boolean>`exists (select 1 from contacts ct where ct.case_id = cases.id
                and ct.type = 'phone' and ct.valid)`,
        otherMode: sql<boolean>`exists (select 1 from interviews iv where iv.case_id = cases.id
                and iv.status = 'in_progress' and iv.mode <> 'CATI')`,
      })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          eq(cases.disposition, 'CALLBACK'),
          inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
          or(
            eq(cases.callbackUserId, userId),
            and(
              isNull(cases.callbackUserId),
              pool
                ? or(eq(cases.assignedTo, userId), isNull(cases.assignedTo))
                : eq(cases.assignedTo, userId),
            ),
          ),
        ),
      )
      .orderBy(asc(cases.nextContactAt))
      .limit(200);
    return rows;
  }
}

@Injectable()
export class PgCatiRepo implements CatiRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: CatiTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) => fn(new PgCatiTx(tx, tenantId, this.audits)));
  }

  extend(t: InterviewsTx): CatiTx {
    const h = t.handle();
    if (h.kind !== 'pg') throw new Error('Not a PostgreSQL transaction');
    return new PgCatiTx(h.tx, h.tenantId, this.audits);
  }
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
    if (h.kind !== 'mssql') throw new Error('Not a SQL Server transaction');
    return new MssqlCatiTx(h.tx, h.tenantId, this.cstore, this.istore, this.cati);
  }
}

export const CATI_REPO = Symbol('CATI_REPO');
