import { Injectable } from '@nestjs/common';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { MssqlCasesTx, PgCasesTx, type CasesTx } from '../cases/cases-repo.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { Database, Prepared, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  cases,
  interviewAnswerEvents,
  interviewDevices,
  interviewParadata,
  interviews,
  projects,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import { InterviewsStore } from './interviews-store.mssql.js';

/**
 * The database side of the interview runtime, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also a `CasesTx`. Rows come out in the shape
 * Drizzle returns, so the modules that have not moved (their submit hooks) read them unchanged.
 */
export type InterviewRow = typeof interviews.$inferSelect;
export type CaseFull = typeof cases.$inferSelect;

export interface AnswerEventRow {
  deviceId: string;
  seq: number;
  variable: string;
  oldValue: unknown;
  newValue: unknown;
  at: Date;
  byUserId: string | null;
  source: string;
  reason: string | null;
}

export interface ParadataRow {
  deviceId: string;
  seq: number;
  type: string;
  at: Date;
  monotonicMs: number | null;
  payload: unknown;
}

export interface FinishSync {
  id: string;
  device: string;
  seq: number;
  touch: boolean;
  hasState: boolean;
  state: Record<string, unknown> | null;
  position: string | null;
  active: number | null;
  total: number | null;
}

/** The open transaction of either engine, to build another module's view of it. */
export type TxHandle =
  { kind: 'pg'; tx: Tx; tenantId: string } | { kind: 'mssql'; tx: MssqlTx; tenantId: string };

export interface InterviewsTx extends CasesTx {
  handle(): TxHandle;
  /** The Drizzle transaction, for modules not yet moved (null on SQL Server). */
  pg(): Tx | null;
  /** The same, where a module that has not moved needs it (throws on SQL Server). */
  native(): Tx;

  // Cases
  lockCase(projectId: string, id: string): Promise<CaseFull | null>;
  lockCases(projectId: string, ids: string[]): Promise<CaseFull[]>;
  lockCaseById(id: string): Promise<CaseFull | null>;
  setCaseInProgress(id: string): Promise<void>;
  finaliseCase(id: string, disposition: string): Promise<void>;
  setCheckout(id: string, v: { device: string; by: string; at: Date } | null): Promise<void>;
  checkIn(projectId: string, ids: string[], deviceId: string, userId: string): Promise<string[]>;
  caseBrief(
    projectId: string,
    id: string,
  ): Promise<{ id: string; assignedTo: string | null } | null>;

  // Interviews
  openInterview(caseId: string): Promise<InterviewRow | null>;
  interview(id: string, lock?: boolean): Promise<InterviewRow | null>;
  takeOver(
    id: string,
    v: { deviceId: string; interviewerId?: string; now: Date },
  ): Promise<InterviewRow>;
  insertInterview(
    v: Pick<
      InterviewRow,
      | 'id'
      | 'projectId'
      | 'caseId'
      | 'questionnaireVersionId'
      | 'mode'
      | 'interviewerId'
      | 'language'
      | 'context'
      | 'deviceId'
    > & { entryPass?: number; startedAt?: Date },
  ): Promise<InterviewRow>;
  ensureDevice(interviewId: string, deviceId: string): Promise<void>;
  deviceSeq(interviewId: string, deviceId: string): Promise<number | undefined>;
  touchDevice(interviewId: string, deviceId: string): Promise<number>;
  insertAnswerEvents(
    interviewId: string,
    deviceId: string,
    rows: {
      seq: number;
      variable: string;
      oldValue: unknown;
      newValue: unknown;
      at: Date;
      byUserId: string | null;
      source: string;
      reason: string | null;
    }[],
  ): Promise<void>;
  insertParadata(
    interviewId: string,
    deviceId: string,
    rows: {
      seq: number;
      type: string;
      at: Date;
      monotonicMs: number | null;
      payload: unknown;
    }[],
  ): Promise<void>;
  finishSync(v: FinishSync): Promise<void>;
  markSubmitted(
    id: string,
    v: {
      extra: Partial<Pick<InterviewRow, 'flags' | 'sampled'>>;
      disposition: string;
      endedAt: Date | null;
      submissions: number;
    },
  ): Promise<InterviewRow>;

  // Versions
  latestPublished(
    projectId: string,
    qid: string,
  ): Promise<{ id: string; version: number; state: string } | null>;
  compiledRaw(versionId: string): Promise<CompiledQuestionnaire | null>;
  versionBrief(versionId: string): Promise<{ version: number; questionnaireId: string } | null>;
  versionRow(versionId: string): Promise<{ id: string; version: number; compiled: unknown } | null>;
  /** A published version of a questionnaire of the project, with the questionnaire's state. */
  publishedVersion(
    projectId: string,
    versionId: string,
  ): Promise<{
    id: string;
    version: number;
    compiled: unknown;
    questionnaireId: string;
    state: string;
  } | null>;
  /** Questionnaires with a published version, active ones, with the modes of their latest. */
  questionnairesWithModes(
    projectId: string,
  ): Promise<{ id: string; name: string; modes: string[] | null }[]>;

  userName(id: string): Promise<string | null>;
  projectName(projectId: string): Promise<string | null>;

  // History of a case
  caseInterviews(caseId: string): Promise<
    {
      id: string;
      status: string;
      mode: string;
      disposition: string | null;
      language: string;
      startedAt: Date;
      endedAt: Date | null;
      activeMs: number;
      interviewer: string | null;
      version: number;
      compiled: unknown;
    }[]
  >;
  answerEventsOf(ids: string[]): Promise<
    {
      interviewId: string;
      variable: string;
      oldValue: unknown;
      newValue: unknown;
      at: Date;
      source: string;
      reason: string | null;
      by: string | null;
      seq: number;
    }[]
  >;
}

export interface InterviewsRepo {
  inTenant<T>(tenantId: string, fn: (t: InterviewsTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

const lockInterview = new Prepared<InterviewRow>(
  (tx) =>
    tx
      .select()
      .from(interviews)
      .where(eq(interviews.id, sql.placeholder('id')))
      .for('update'),
  getTableColumns(interviews),
);
const deviceSeqQ = new Prepared<{ lastSeq: number }>(
  (tx) =>
    tx
      .select({ lastSeq: interviewDevices.lastSeq })
      .from(interviewDevices)
      .where(
        and(
          eq(interviewDevices.interviewId, sql.placeholder('id')),
          eq(interviewDevices.deviceId, sql.placeholder('device')),
        ),
      ),
  { lastSeq: interviewDevices.lastSeq },
);
const touchDeviceQ = new Prepared<{ lastSeq: number }>(
  (tx) =>
    tx
      .insert(interviewDevices)
      .values({
        tenantId: sql.placeholder('tenantId'),
        interviewId: sql.placeholder('id'),
        deviceId: sql.placeholder('device'),
      })
      .onConflictDoUpdate({
        target: [interviewDevices.interviewId, interviewDevices.deviceId],
        set: { updatedAt: sql`now()` },
      })
      .returning({ lastSeq: interviewDevices.lastSeq }),
  { lastSeq: interviewDevices.lastSeq },
);
/**
 * The end of a sync: the interview's snapshot and times (when `touch`; only the fields sent)
 * and the device's acknowledged number, in one statement. A new snapshot bumps the state's
 * version and keeps the codes given to "other" texts (`<VAR>_CODE`, not in the snapshot)
 * whose text is unchanged.
 */
const finishSyncQ = new Prepared<never>(
  () => sql`
    with i as (
      update interviews set
        state = case when ${sql.placeholder('hasState')} then ${sql.placeholder('state')}::jsonb else state end,
        answers = case when ${sql.placeholder('hasState')} then coalesce((
            select jsonb_object_agg(k.key, k.value) from jsonb_each(answers) k
            where k.key like '%\\_CODE'
              and ${sql.placeholder('answers')}::jsonb -> (left(k.key, -5) || '_OTHER')
                = answers -> (left(k.key, -5) || '_OTHER')
          ), '{}'::jsonb) || ${sql.placeholder('answers')}::jsonb else answers end,
        state_version = state_version + case when ${sql.placeholder('hasState')} then 1 else 0 end,
        state_device = case when ${sql.placeholder('hasState')} then ${sql.placeholder('device')}::text else state_device end,
        position = case when ${sql.placeholder('hasState')} then ${sql.placeholder('position')}::text else position end,
        active_ms = coalesce(${sql.placeholder('active')}::int, active_ms),
        total_ms = coalesce(${sql.placeholder('total')}::int, total_ms),
        updated_at = now()
      where id = ${sql.placeholder('id')} and ${sql.placeholder('touch')}::boolean
    )
    update interview_devices set last_seq = ${sql.placeholder('seq')}::int, updated_at = now()
    where interview_id = ${sql.placeholder('id')} and device_id = ${sql.placeholder('device')}`,
  {},
);

export class PgInterviewsTx extends PgCasesTx implements InterviewsTx {
  constructor(
    private readonly itx: Tx,
    private readonly tenant: string,
    audits: AuditService,
  ) {
    super(itx, tenant, audits);
  }

  handle(): TxHandle {
    return { kind: 'pg', tx: this.itx, tenantId: this.tenant };
  }

  pg() {
    return this.itx;
  }

  native() {
    return this.itx;
  }

  async lockCase(projectId: string, id: string) {
    const [c] = await this.itx
      .select()
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.projectId, projectId)))
      .for('update');
    return c ?? null;
  }

  lockCases(projectId: string, ids: string[]) {
    return this.itx
      .select()
      .from(cases)
      .where(and(eq(cases.projectId, projectId), inArray(cases.id, ids)))
      .for('update');
  }

  async lockCaseById(id: string) {
    const [c] = await this.itx.select().from(cases).where(eq(cases.id, id)).for('update');
    return c ?? null;
  }

  async setCaseInProgress(id: string) {
    await this.itx
      .update(cases)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(cases.id, id));
  }

  async finaliseCase(id: string, disposition: string) {
    await this.itx
      .update(cases)
      .set({ status: 'finalised', disposition, updatedAt: new Date() })
      .where(eq(cases.id, id));
  }

  async setCheckout(id: string, v: { device: string; by: string; at: Date } | null) {
    await this.itx
      .update(cases)
      .set(
        v
          ? { checkedOutDevice: v.device, checkedOutBy: v.by, checkedOutAt: v.at }
          : { checkedOutDevice: null, checkedOutBy: null, checkedOutAt: null },
      )
      .where(eq(cases.id, id));
  }

  async checkIn(projectId: string, ids: string[], deviceId: string, userId: string) {
    const back = await this.itx
      .update(cases)
      .set({ checkedOutDevice: null, checkedOutBy: null, checkedOutAt: null })
      .where(
        and(
          eq(cases.projectId, projectId),
          inArray(cases.id, ids),
          eq(cases.checkedOutDevice, deviceId),
          eq(cases.checkedOutBy, userId),
        ),
      )
      .returning({ id: cases.id });
    return back.map((b) => b.id);
  }

  async caseBrief(projectId: string, id: string) {
    const [c] = await this.itx
      .select({ id: cases.id, assignedTo: cases.assignedTo })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.projectId, projectId)));
    return c ?? null;
  }

  async openInterview(caseId: string) {
    const [o] = await this.itx
      .select()
      .from(interviews)
      .where(and(eq(interviews.caseId, caseId), eq(interviews.status, 'in_progress')));
    return o ?? null;
  }

  async interview(id: string, lock = false) {
    if (lock) return (await lockInterview.run(this.itx, { id }))[0] ?? null;
    const [r] = await this.itx.select().from(interviews).where(eq(interviews.id, id));
    return r ?? null;
  }

  async takeOver(id: string, v: { deviceId: string; interviewerId?: string; now: Date }) {
    const [row] = await this.itx
      .update(interviews)
      .set({
        deviceId: v.deviceId,
        ...(v.interviewerId ? { interviewerId: v.interviewerId } : {}),
        updatedAt: v.now,
      })
      .where(eq(interviews.id, id))
      .returning();
    return row!;
  }

  async insertInterview(v: Parameters<InterviewsTx['insertInterview']>[0]) {
    const [row] = await this.itx
      .insert(interviews)
      .values({ tenantId: this.tenant, ...v })
      .returning();
    return row!;
  }

  async ensureDevice(interviewId: string, deviceId: string) {
    await this.itx
      .insert(interviewDevices)
      .values({ tenantId: this.tenant, interviewId, deviceId })
      .onConflictDoNothing();
  }

  async deviceSeq(interviewId: string, deviceId: string) {
    return (await deviceSeqQ.run(this.itx, { id: interviewId, device: deviceId }))[0]?.lastSeq;
  }

  async touchDevice(interviewId: string, deviceId: string) {
    const [d] = await touchDeviceQ.run(this.itx, {
      tenantId: this.tenant,
      id: interviewId,
      device: deviceId,
    });
    return d?.lastSeq ?? 0;
  }

  async insertAnswerEvents(
    interviewId: string,
    deviceId: string,
    rows: Parameters<InterviewsTx['insertAnswerEvents']>[2],
  ) {
    if (!rows.length) return;
    await this.itx
      .insert(interviewAnswerEvents)
      .values(rows.map((o) => ({ tenantId: this.tenant, interviewId, deviceId, ...o })))
      .onConflictDoNothing();
  }

  async insertParadata(
    interviewId: string,
    deviceId: string,
    rows: Parameters<InterviewsTx['insertParadata']>[2],
  ) {
    if (!rows.length) return;
    await this.itx
      .insert(interviewParadata)
      .values(
        rows.map((o) => ({
          tenantId: this.tenant,
          interviewId,
          deviceId,
          ...o,
          payload: o.payload as Record<string, unknown>,
        })),
      )
      .onConflictDoNothing();
  }

  async finishSync(v: FinishSync) {
    await finishSyncQ.run(this.itx, {
      id: v.id,
      device: v.device,
      seq: v.seq,
      touch: v.touch,
      hasState: v.hasState,
      state: v.state ? JSON.stringify(v.state) : null,
      answers: v.state ? JSON.stringify(v.state['answers'] ?? {}) : null,
      position: v.position,
      active: v.active,
      total: v.total,
    });
  }

  async markSubmitted(id: string, v: Parameters<InterviewsTx['markSubmitted']>[1]) {
    const [done] = await this.itx
      .update(interviews)
      .set({
        ...v.extra,
        status: 'submitted',
        disposition: v.disposition,
        endedAt: v.endedAt ?? new Date(),
        submittedAt: new Date(),
        submissions: v.submissions + 1,
        updatedAt: new Date(),
      })
      .where(eq(interviews.id, id))
      .returning();
    return done!;
  }

  async latestPublished(projectId: string, qid: string) {
    const [found] = await this.itx
      .select({
        id: questionnaireVersions.id,
        version: questionnaireVersions.version,
        state: questionnaires.state,
      })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaires.id, qid),
          eq(questionnaires.projectId, projectId),
          eq(questionnaireVersions.status, 'published'),
        ),
      )
      .orderBy(desc(questionnaireVersions.version))
      .limit(1);
    return found ?? null;
  }

  async compiledRaw(versionId: string) {
    const [v] = await this.itx
      .select({ compiled: questionnaireVersions.compiled })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    return (v?.compiled as CompiledQuestionnaire | undefined) ?? null;
  }

  async versionBrief(versionId: string) {
    const [v] = await this.itx
      .select({
        version: questionnaireVersions.version,
        questionnaireId: questionnaireVersions.questionnaireId,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    return v ?? null;
  }

  async versionRow(versionId: string) {
    const [v] = await this.itx
      .select({
        id: questionnaireVersions.id,
        version: questionnaireVersions.version,
        compiled: questionnaireVersions.compiled,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    return v ?? null;
  }

  async publishedVersion(projectId: string, versionId: string) {
    const [v] = await this.itx
      .select({
        id: questionnaireVersions.id,
        version: questionnaireVersions.version,
        compiled: questionnaireVersions.compiled,
        questionnaireId: questionnaires.id,
        state: questionnaires.state,
      })
      .from(questionnaireVersions)
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(
        and(
          eq(questionnaireVersions.id, versionId),
          eq(questionnaires.projectId, projectId),
          eq(questionnaireVersions.status, 'published'),
        ),
      );
    return v ?? null;
  }

  async questionnairesWithModes(projectId: string) {
    return this.itx
      .selectDistinctOn([questionnaires.id], {
        id: questionnaires.id,
        name: questionnaires.name,
        modes: sql<
          string[] | null
        >`${questionnaireVersions.compiled} -> 'questionnaire' -> 'modes'`,
      })
      .from(questionnaires)
      .innerJoin(
        questionnaireVersions,
        eq(questionnaireVersions.questionnaireId, questionnaires.id),
      )
      .where(
        and(
          eq(questionnaires.projectId, projectId),
          eq(questionnaireVersions.status, 'published'),
          // Disabled and completed questionnaires take no new fills.
          eq(questionnaires.state, 'active'),
        ),
      )
      .orderBy(questionnaires.id, desc(questionnaireVersions.version));
  }

  async userName(id: string) {
    const [u] = await this.itx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? null;
  }

  async projectName(projectId: string) {
    const [p] = await this.itx
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    return p?.name ?? null;
  }

  caseInterviews(caseId: string) {
    return this.itx
      .select({
        id: interviews.id,
        status: interviews.status,
        mode: interviews.mode,
        disposition: interviews.disposition,
        language: interviews.language,
        startedAt: interviews.startedAt,
        endedAt: interviews.endedAt,
        activeMs: interviews.activeMs,
        interviewer: users.name,
        version: questionnaireVersions.version,
        compiled: questionnaireVersions.compiled,
      })
      .from(interviews)
      .innerJoin(
        questionnaireVersions,
        eq(questionnaireVersions.id, interviews.questionnaireVersionId),
      )
      .leftJoin(users, eq(users.id, interviews.interviewerId))
      .where(eq(interviews.caseId, caseId))
      .orderBy(desc(interviews.startedAt));
  }

  async answerEventsOf(ids: string[]) {
    if (!ids.length) return [];
    return this.itx
      .select({
        interviewId: interviewAnswerEvents.interviewId,
        variable: interviewAnswerEvents.variable,
        oldValue: interviewAnswerEvents.oldValue,
        newValue: interviewAnswerEvents.newValue,
        at: interviewAnswerEvents.at,
        source: interviewAnswerEvents.source,
        reason: interviewAnswerEvents.reason,
        by: users.name,
        seq: interviewAnswerEvents.seq,
      })
      .from(interviewAnswerEvents)
      .leftJoin(users, eq(users.id, interviewAnswerEvents.byUserId))
      .where(inArray(interviewAnswerEvents.interviewId, ids))
      .orderBy(asc(interviewAnswerEvents.at), asc(interviewAnswerEvents.seq));
  }
}

@Injectable()
export class PgInterviewsRepo implements InterviewsRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: InterviewsTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) =>
      fn(new PgInterviewsTx(tx, tenantId, this.audits)),
    );
  }

  /** The same operations inside a transaction someone else opened (modules not yet moved). */
  wrap(tx: Tx, tenantId: string): InterviewsTx {
    return new PgInterviewsTx(tx, tenantId, this.audits);
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

export function toCase(r: Record<string, unknown> & { sample: string }): CaseFull {
  const g = (k: string) => r[k] as never;
  const id = (k: string) => lowOrNull((r[k] as string | null) ?? null);
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    questionnaireId: id('questionnaire_id'),
    externalId: g('external_id'),
    sample: parse(r.sample),
    samplePii: g('sample_pii'),
    samplePiiIndex: r.sample_pii_index ? parse(r.sample_pii_index as string) : null,
    anonymisedAt: g('anonymised_at'),
    status: g('status'),
    disposition: g('disposition'),
    priority: g('priority'),
    modePreference: g('mode_preference'),
    assignedTo: id('assigned_to'),
    assignedAt: g('assigned_at'),
    importId: id('import_id'),
    attempts: g('attempts'),
    lastAttemptAt: g('last_attempt_at'),
    nextContactAt: g('next_contact_at'),
    callbackUserId: id('callback_user_id'),
    callLockUserId: id('call_lock_user_id'),
    callLockUntil: g('call_lock_until'),
    checkedOutDevice: g('checked_out_device'),
    checkedOutBy: id('checked_out_by'),
    checkedOutAt: g('checked_out_at'),
    frameUnitId: id('frame_unit_id'),
    selectionRole: g('selection_role'),
    substituteFor: id('substitute_for'),
    inclusionProb: g('inclusion_prob'),
    baseWeight: g('base_weight'),
    createdAt: g('created_at'),
    updatedAt: g('updated_at'),
  } as unknown as CaseFull;
}

export function toInterview(r: Record<string, unknown>): InterviewRow {
  const g = (k: string) => r[k] as never;
  const id = (k: string) => lowOrNull((r[k] as string | null) ?? null);
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    caseId: id('case_id'),
    questionnaireVersionId: low(r.questionnaire_version_id as string),
    mode: g('mode'),
    interviewerId: id('interviewer_id'),
    status: g('status'),
    disposition: g('disposition'),
    language: g('language'),
    context: parse(r.context as string),
    state: parse(r.state as string),
    answers: parse(r.answers as string),
    stateVersion: g('state_version'),
    stateDevice: g('state_device'),
    position: g('position'),
    deviceId: g('device_id'),
    startedAt: g('started_at'),
    endedAt: g('ended_at'),
    entryPass: g('entry_pass'),
    activeMs: g('active_ms'),
    totalMs: g('total_ms'),
    flags: parse(r.flags as string),
    sampled: !!r.sampled,
    submittedAt: g('submitted_at'),
    submissions: g('submissions'),
    reviewedBy: id('reviewed_by'),
    reviewedAt: g('reviewed_at'),
    updatedAt: g('updated_at'),
  } as unknown as InterviewRow;
}

export class MssqlInterviewsTx extends MssqlCasesTx implements InterviewsTx {
  constructor(
    private readonly itx: MssqlTx,
    private readonly tenant: string,
    cstore: CasesStore,
    private readonly istore: InterviewsStore,
  ) {
    super(itx, tenant, cstore);
  }

  handle(): TxHandle {
    return { kind: 'mssql', tx: this.itx, tenantId: this.tenant };
  }

  pg(): Tx | null {
    return null;
  }

  native(): Tx {
    throw new Error('This module has not moved to SQL Server yet');
  }

  async lockCase(projectId: string, id: string) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases WITH (UPDLOCK, ROWLOCK) WHERE id = ${id} AND project_id = ${projectId}`.execute(
      this.itx,
    );
    return res.rows[0] ? toCase(res.rows[0]) : null;
  }

  async lockCases(projectId: string, ids: string[]) {
    if (!ids.length) return [];
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases WITH (UPDLOCK, ROWLOCK)
      WHERE project_id = ${projectId}
        AND id IN (SELECT CAST(j.[value] AS uniqueidentifier) FROM OPENJSON(${JSON.stringify(ids)}) j)
      ORDER BY id`.execute(this.itx);
    return res.rows.map(toCase);
  }

  async lockCaseById(id: string) {
    const res = await ksql<Record<string, unknown> & { sample: string }>`
      SELECT * FROM dbo.cases WITH (UPDLOCK, ROWLOCK) WHERE id = ${id}`.execute(this.itx);
    return res.rows[0] ? toCase(res.rows[0]) : null;
  }

  async setCaseInProgress(id: string) {
    await this.itx
      .updateTable('cases')
      .set({ status: 'in_progress', updated_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .execute();
  }

  async finaliseCase(id: string, disposition: string) {
    await this.itx
      .updateTable('cases')
      .set({ status: 'finalised', disposition, updated_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .execute();
  }

  async setCheckout(id: string, v: { device: string; by: string; at: Date } | null) {
    await this.itx
      .updateTable('cases')
      .set(
        v
          ? {
              checked_out_device: v.device,
              checked_out_by: v.by,
              checked_out_at: instant(v.at),
            }
          : { checked_out_device: null, checked_out_by: null, checked_out_at: null },
      )
      .where('id', '=', id)
      .execute();
  }

  async checkIn(projectId: string, ids: string[], deviceId: string, userId: string) {
    const res = await ksql<{ id: string }>`
      UPDATE dbo.cases SET checked_out_device = NULL, checked_out_by = NULL, checked_out_at = NULL
      OUTPUT inserted.id
      WHERE project_id = ${projectId}
        AND id IN (SELECT CAST(j.[value] AS uniqueidentifier) FROM OPENJSON(${JSON.stringify(ids)}) j)
        AND checked_out_device = ${deviceId} AND checked_out_by = ${userId}`.execute(this.itx);
    return res.rows.map((r) => low(r.id));
  }

  async caseBrief(projectId: string, id: string) {
    const c = await this.itx
      .selectFrom('cases')
      .select(['id', 'assigned_to'])
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return c ? { id: low(c.id), assignedTo: lowOrNull(c.assigned_to) } : null;
  }

  async openInterview(caseId: string) {
    const r = await this.istore.openForCase(this.itx, caseId);
    return r ? this.fresh(r.id) : null;
  }

  /** The row in Drizzle's shape (the store's rows are SQL Server's). */
  private async fresh(id: string) {
    const r = await this.itx
      .selectFrom('interviews')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toInterview(r as never) : null;
  }

  async interview(id: string, lock = false) {
    if (lock) await this.istore.lock(this.itx, id);
    return this.fresh(id);
  }

  async takeOver(id: string, v: { deviceId: string; interviewerId?: string; now: Date }) {
    await this.itx
      .updateTable('interviews')
      .set({
        device_id: v.deviceId,
        ...(v.interviewerId ? { interviewer_id: v.interviewerId } : {}),
        updated_at: instant(v.now),
      })
      .where('id', '=', id)
      .execute();
    return (await this.fresh(id))!;
  }

  async insertInterview(v: Parameters<InterviewsTx['insertInterview']>[0]) {
    await this.itx
      .insertInto('interviews')
      .values({
        id: v.id,
        tenant_id: this.tenant,
        project_id: v.projectId,
        case_id: v.caseId,
        questionnaire_version_id: v.questionnaireVersionId,
        mode: v.mode,
        interviewer_id: v.interviewerId,
        language: v.language,
        context: JSON.stringify(v.context),
        device_id: v.deviceId,
        entry_pass: v.entryPass ?? 1,
        state: '{}',
        answers: '{}',
        flags: '{}',
        ended_at: null,
        submitted_at: null,
        reviewed_by: null,
        reviewed_at: null,
        disposition: null,
        position: null,
        state_device: null,
        ...(v.startedAt ? { started_at: instant(v.startedAt) } : {}),
      })
      .execute();
    return (await this.fresh(v.id))!;
  }

  async ensureDevice(interviewId: string, deviceId: string) {
    await this.istore.touchDevice(this.itx, { tenantId: this.tenant, interviewId, deviceId });
  }

  deviceSeq(interviewId: string, deviceId: string) {
    return this.istore.deviceSeq(this.itx, interviewId, deviceId);
  }

  touchDevice(interviewId: string, deviceId: string) {
    return this.istore.touchDevice(this.itx, { tenantId: this.tenant, interviewId, deviceId });
  }

  insertAnswerEvents(
    interviewId: string,
    deviceId: string,
    rows: Parameters<InterviewsTx['insertAnswerEvents']>[2],
  ) {
    return this.istore.appendAnswers(this.itx, {
      tenantId: this.tenant,
      interviewId,
      deviceId,
      ops: rows.map((o) => ({
        seq: o.seq,
        variable: o.variable,
        oldValue: o.oldValue,
        newValue: o.newValue,
        at: o.at.toISOString(),
        byUserId: o.byUserId,
        source: o.source,
        reason: o.reason,
      })),
    });
  }

  insertParadata(
    interviewId: string,
    deviceId: string,
    rows: Parameters<InterviewsTx['insertParadata']>[2],
  ) {
    return this.istore.appendParadata(this.itx, {
      tenantId: this.tenant,
      interviewId,
      deviceId,
      ops: rows.map((o) => ({
        seq: o.seq,
        type: o.type,
        at: o.at.toISOString(),
        monotonicMs: o.monotonicMs,
        payload: o.payload,
      })),
    });
  }

  finishSync(v: FinishSync) {
    return this.istore.finishSync(this.itx, {
      id: v.id,
      device: v.device,
      seq: v.seq,
      touch: v.touch,
      hasState: v.hasState,
      state: v.state,
      position: v.position,
      activeMs: v.active,
      totalMs: v.total,
    });
  }

  async markSubmitted(id: string, v: Parameters<InterviewsTx['markSubmitted']>[1]) {
    await this.istore.markSubmitted(this.itx, id, {
      disposition: v.disposition,
      flags: v.extra.flags as Record<string, unknown> | undefined,
      sampled: v.extra.sampled,
    });
    return (await this.fresh(id))!;
  }

  async latestPublished(projectId: string, qid: string) {
    const r = await this.itx
      .selectFrom('questionnaire_versions as v')
      .innerJoin('questionnaires as q', 'q.id', 'v.questionnaire_id')
      .select(['v.id', 'v.version', 'q.state'])
      .where('q.id', '=', qid)
      .where('q.project_id', '=', projectId)
      .where('v.status', '=', 'published')
      .orderBy('v.version', 'desc')
      .top(1)
      .executeTakeFirst();
    return r ? { id: low(r.id), version: r.version, state: r.state } : null;
  }

  async compiledRaw(versionId: string) {
    const r = await this.itx
      .selectFrom('questionnaire_versions')
      .select('compiled')
      .where('id', '=', versionId)
      .executeTakeFirst();
    return r ? parse<CompiledQuestionnaire>(r.compiled) : null;
  }

  async versionBrief(versionId: string) {
    const r = await this.itx
      .selectFrom('questionnaire_versions')
      .select(['version', 'questionnaire_id'])
      .where('id', '=', versionId)
      .executeTakeFirst();
    return r ? { version: r.version, questionnaireId: low(r.questionnaire_id) } : null;
  }

  async versionRow(versionId: string) {
    const r = await this.itx
      .selectFrom('questionnaire_versions')
      .select(['id', 'version', 'compiled'])
      .where('id', '=', versionId)
      .executeTakeFirst();
    return r ? { id: low(r.id), version: r.version, compiled: parse(r.compiled) } : null;
  }

  async publishedVersion(projectId: string, versionId: string) {
    const r = await this.itx
      .selectFrom('questionnaire_versions as v')
      .innerJoin('questionnaires as q', 'q.id', 'v.questionnaire_id')
      .select(['v.id', 'v.version', 'v.compiled', 'q.id as qid', 'q.state'])
      .where('v.id', '=', versionId)
      .where('q.project_id', '=', projectId)
      .where('v.status', '=', 'published')
      .executeTakeFirst();
    return r
      ? {
          id: low(r.id),
          version: r.version,
          compiled: parse(r.compiled),
          questionnaireId: low(r.qid),
          state: r.state,
        }
      : null;
  }

  async questionnairesWithModes(projectId: string) {
    const res = await ksql<{ id: string; name: string; modes: string | null }>`
      SELECT id, name, modes FROM (
        SELECT q.id, q.name,
          JSON_QUERY(v.compiled, '$.questionnaire.modes') AS modes,
          ROW_NUMBER() OVER (PARTITION BY q.id ORDER BY v.version DESC) AS rn
        FROM dbo.questionnaires q
        JOIN dbo.questionnaire_versions v ON v.questionnaire_id = q.id
        WHERE q.project_id = ${projectId} AND v.status = 'published' AND q.state = 'active'
      ) t WHERE rn = 1 ORDER BY id`.execute(this.itx);
    return res.rows.map((r) => ({
      id: low(r.id),
      name: r.name,
      modes: parse<string[] | null>(r.modes),
    }));
  }

  async userName(id: string) {
    const u = await this.itx
      .selectFrom('users')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst();
    return u?.name ?? null;
  }

  async projectName(projectId: string) {
    const p = await this.itx
      .selectFrom('projects')
      .select('name')
      .where('id', '=', projectId)
      .executeTakeFirst();
    return p?.name ?? null;
  }

  async caseInterviews(caseId: string) {
    const rows = await this.itx
      .selectFrom('interviews as i')
      .innerJoin('questionnaire_versions as v', 'v.id', 'i.questionnaire_version_id')
      .leftJoin('users as u', 'u.id', 'i.interviewer_id')
      .select([
        'i.id',
        'i.status',
        'i.mode',
        'i.disposition',
        'i.language',
        'i.started_at',
        'i.ended_at',
        'i.active_ms',
        'u.name as interviewer',
        'v.version',
        'v.compiled',
      ])
      .where('i.case_id', '=', caseId)
      .orderBy('i.started_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      status: r.status,
      mode: r.mode,
      disposition: r.disposition,
      language: r.language,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      activeMs: r.active_ms,
      interviewer: r.interviewer,
      version: r.version,
      compiled: parse(r.compiled),
    }));
  }

  async answerEventsOf(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.itx
      .selectFrom('interview_answer_events as e')
      .leftJoin('users as u', 'u.id', 'e.by_user_id')
      .select([
        'e.interview_id',
        'e.variable',
        'e.old_value',
        'e.new_value',
        'e.at',
        'e.source',
        'e.reason',
        'u.name as by',
        'e.seq',
      ])
      .where('e.interview_id', 'in', ids)
      .orderBy('e.at')
      .orderBy('e.seq')
      .execute();
    return rows.map((r) => ({
      interviewId: low(r.interview_id),
      variable: r.variable,
      oldValue: parse<unknown>(r.old_value),
      newValue: parse<unknown>(r.new_value),
      at: r.at as unknown as Date,
      source: r.source,
      reason: r.reason,
      by: r.by,
      seq: r.seq,
    }));
  }
}

@Injectable()
export class MssqlInterviewsRepo implements InterviewsRepo {
  private readonly cstore = new CasesStore();
  private readonly store = new InterviewsStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: InterviewsTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlInterviewsTx(tx, tenantId, this.cstore, this.store)),
    );
  }
}

export const INTERVIEWS_REPO = Symbol('INTERVIEWS_REPO');
