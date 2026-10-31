import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { ofQuestionnaire } from '../cases/cases.service.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  cases,
  entryMismatches,
  interviewAnswerEvents,
  interviews,
  papiScanBatches,
  papiScanForms,
  papiScanPages,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import { claimable, MAX_JOB_ATTEMPTS, STUCK_AFTER_MS } from '../jobs/claims.js';
import { claimJob } from '../jobs/claim.mssql.js';
import {
  MssqlInterviewsTx,
  PgInterviewsTx,
  toCase,
  type CaseFull,
  type InterviewRow,
  type InterviewsTx,
} from '../interviews/interviews-repo.js';
import { InterviewsStore } from '../interviews/interviews-store.mssql.js';

/**
 * The database side of paper interviewing (double entry) and scanned forms, whichever engine
 * runs (the pattern of `auth/auth-repo.ts`). A transaction here is also an `InterviewsTx`.
 */
export type MismatchRow = typeof entryMismatches.$inferSelect;
export type BatchView = typeof papiScanBatches.$inferSelect;
export type FormView = typeof papiScanForms.$inferSelect;

export interface FormCase {
  id: string;
  externalId: string;
  sample: unknown;
  samplePii: string | null;
  status: string;
  priority: number;
  modePreference: string | null;
  assignedTo: string | null;
}

export interface MismatchListing {
  id: string;
  caseId: string;
  externalId: string;
  variable: string;
  firstValue: unknown;
  secondValue: unknown;
  status: string;
  resolvedValue: unknown;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  firstInterviewId: string;
  questionnaireVersionId: string;
}

export interface NewForm {
  id: string;
  projectId: string;
  batchId: string;
  caseId: string;
  questionnaireVersionId: string;
  lang: string;
  pagesExpected: number;
  pagesFound: number[];
  interviewId?: string;
  status: string;
  issues: unknown[];
}

export interface NewPage {
  batchId: string;
  formId: string | null;
  pageNo: number;
  formPage: number | null;
  problem: string | null;
  transform: unknown;
  width: number;
  height: number;
  image: Buffer;
}

export interface PapiTx extends InterviewsTx {
  // ─── Forms to print, keying, double entry ───────────────────────────────────────────
  /** Cases of the project for printing, by external id; `userId` restricts to the person's own. */
  formCases(
    projectId: string,
    q: { userId: string | null; caseIds?: string[]; questionnaireId?: string },
  ): Promise<FormCase[]>;
  /** The PAPI interviews of a case, newest first. */
  paperInterviews(caseId: string): Promise<InterviewRow[]>;
  caseByExternalId(
    projectId: string,
    externalId: string,
  ): Promise<{ id: string; externalId: string; status: string; assignedTo: string | null } | null>;
  /** The case goes back in progress (it waits for a second keying or for differences). */
  reopenCase(caseId: string): Promise<void>;
  /** The first keying of a case that was sent. */
  firstEntry(caseId: string, statuses: string[]): Promise<InterviewRow | null>;
  insertMismatches(
    rows: {
      projectId: string;
      caseId: string;
      firstInterviewId: string;
      secondInterviewId: string;
      variable: string;
      firstValue: unknown;
      secondValue: unknown;
    }[],
  ): Promise<void>;
  mismatches(projectId: string, status: 'open' | 'resolved' | 'all'): Promise<MismatchListing[]>;
  lockMismatch(projectId: string, id: string): Promise<MismatchRow | null>;
  resolveMismatch(id: string, v: { value: unknown; by: string; at: Date }): Promise<void>;
  /** Sets (or, with null, drops) one answer of an interview, in its answers and in its state. */
  overwriteAnswer(interviewId: string, variable: string, value: unknown, at: Date): Promise<void>;
  nextEventSeq(interviewId: string, deviceId: string): Promise<number>;
  openMismatches(secondInterviewId: string): Promise<number>;

  // ─── Scans ──────────────────────────────────────────────────────────────────────────
  insertBatch(v: {
    projectId: string;
    uploadedBy: string;
    fileName: string;
    pdf: Buffer;
  }): Promise<string>;
  /** Takes the batch once: a queued one, or one whose worker was lost. */
  claimBatch(id: string): Promise<BatchView | null>;
  failBatch(id: string, error: string): Promise<void>;
  finishBatch(id: string, pages: number): Promise<void>;
  caseInProject(projectId: string, id: string): Promise<CaseFull | null>;
  insertForm(v: NewForm): Promise<void>;
  insertPages(rows: NewPage[]): Promise<void>;
  /** An interview of the case already keyed, or being keyed. */
  hasTakenInterview(caseId: string): Promise<boolean>;
  batches(projectId: string): Promise<
    {
      id: string;
      fileName: string;
      status: string;
      pages: number;
      error: string | null;
      createdAt: Date;
      uploadedBy: string | null;
    }[]
  >;
  scanForms(batchIds: string[]): Promise<
    {
      id: string;
      batchId: string;
      caseId: string;
      externalId: string;
      interviewId: string | null;
      status: string;
      pagesExpected: number;
      pagesFound: number[];
      issues: unknown;
      interviewStatus: string | null;
    }[]
  >;
  strayPages(
    batchIds: string[],
  ): Promise<{ batchId: string; pageNo: number; problem: string | null }[]>;
  formOfInterview(interviewId: string): Promise<FormView | null>;
  formOf(projectId: string, id: string): Promise<FormView | null>;
  formPages(formId: string): Promise<
    {
      id: string;
      formPage: number | null;
      transform: unknown;
      width: number;
      height: number;
    }[]
  >;
  /** A scanned page's image, when the page belongs to the project. */
  pageImage(projectId: string, pageId: string): Promise<Buffer | null>;
  /** The person keying the second round holds the interview; null when it is finished. */
  claimInterview(interviewId: string, userId: string): Promise<string | null>;
  assignCase(caseId: string, userId: string): Promise<void>;
  questionnaireName(id: string): Promise<string | null>;
  versionIdOf(questionnaireId: string, version: number): Promise<string | null>;
}

export interface PapiRepo {
  inTenant<T>(tenantId: string, fn: (t: PapiTx) => Promise<T>): Promise<T>;
  /** The same transaction, seen as paper (for the submit hook). */
  extend(t: InterviewsTx): PapiTx;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

export class PgPapiTx extends PgInterviewsTx implements PapiTx {
  constructor(
    private readonly ptx: Tx,
    private readonly pten: string,
    audits: AuditService,
  ) {
    super(ptx, pten, audits);
  }

  formCases(
    projectId: string,
    q: { userId: string | null; caseIds?: string[]; questionnaireId?: string },
  ) {
    const conds = [eq(cases.projectId, projectId)];
    if (q.userId) conds.push(eq(cases.assignedTo, q.userId));
    if (q.caseIds?.length) conds.push(inArray(cases.id, q.caseIds));
    // Each questionnaire prints its own cases.
    const ofQ = ofQuestionnaire(q.questionnaireId);
    if (ofQ) conds.push(ofQ);
    return this.ptx
      .select({
        id: cases.id,
        externalId: cases.externalId,
        sample: cases.sample,
        samplePii: cases.samplePii,
        status: cases.status,
        priority: cases.priority,
        modePreference: cases.modePreference,
        assignedTo: cases.assignedTo,
      })
      .from(cases)
      .where(and(...conds))
      .orderBy(asc(cases.externalId));
  }

  paperInterviews(caseId: string) {
    return this.ptx
      .select()
      .from(interviews)
      .where(and(eq(interviews.caseId, caseId), eq(interviews.mode, 'PAPI')))
      .orderBy(desc(interviews.startedAt));
  }

  async caseByExternalId(projectId: string, externalId: string) {
    const [c] = await this.ptx
      .select({
        id: cases.id,
        externalId: cases.externalId,
        status: cases.status,
        assignedTo: cases.assignedTo,
      })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), eq(cases.externalId, externalId)));
    return c ?? null;
  }

  async reopenCase(caseId: string) {
    await this.ptx
      .update(cases)
      .set({ status: 'in_progress', disposition: null, updatedAt: new Date() })
      .where(eq(cases.id, caseId));
  }

  async firstEntry(caseId: string, statuses: string[]) {
    const [first] = await this.ptx
      .select()
      .from(interviews)
      .where(
        and(
          eq(interviews.caseId, caseId),
          eq(interviews.mode, 'PAPI'),
          eq(interviews.entryPass, 1),
          inArray(interviews.status, statuses),
        ),
      );
    return first ?? null;
  }

  async insertMismatches(rows: Parameters<PapiTx['insertMismatches']>[0]) {
    if (!rows.length) return;
    await this.ptx.insert(entryMismatches).values(rows.map((r) => ({ tenantId: this.pten, ...r })));
  }

  mismatches(projectId: string, status: 'open' | 'resolved' | 'all') {
    return this.ptx
      .select({
        id: entryMismatches.id,
        caseId: entryMismatches.caseId,
        externalId: cases.externalId,
        variable: entryMismatches.variable,
        firstValue: entryMismatches.firstValue,
        secondValue: entryMismatches.secondValue,
        status: entryMismatches.status,
        resolvedValue: entryMismatches.resolvedValue,
        resolvedBy: users.name,
        resolvedAt: entryMismatches.resolvedAt,
        firstInterviewId: entryMismatches.firstInterviewId,
        questionnaireVersionId: interviews.questionnaireVersionId,
      })
      .from(entryMismatches)
      .innerJoin(cases, eq(cases.id, entryMismatches.caseId))
      .innerJoin(interviews, eq(interviews.id, entryMismatches.firstInterviewId))
      .leftJoin(users, eq(users.id, entryMismatches.resolvedBy))
      .where(
        and(
          eq(entryMismatches.projectId, projectId),
          status === 'all' ? sql`true` : eq(entryMismatches.status, status),
        ),
      )
      .orderBy(asc(cases.externalId), asc(entryMismatches.variable))
      .limit(1000);
  }

  async lockMismatch(projectId: string, id: string) {
    const [m] = await this.ptx
      .select()
      .from(entryMismatches)
      .where(and(eq(entryMismatches.id, id), eq(entryMismatches.projectId, projectId)))
      .for('update');
    return m ?? null;
  }

  async resolveMismatch(id: string, v: { value: unknown; by: string; at: Date }) {
    await this.ptx
      .update(entryMismatches)
      .set({ status: 'resolved', resolvedValue: v.value, resolvedBy: v.by, resolvedAt: v.at })
      .where(eq(entryMismatches.id, id));
  }

  async overwriteAnswer(interviewId: string, variable: string, value: unknown, at: Date) {
    const path = `{${variable}}`;
    const statePath = `{answers,${variable}}`;
    await this.ptx
      .update(interviews)
      .set({
        answers:
          value === null
            ? sql`${interviews.answers} - ${variable}`
            : sql`jsonb_set(${interviews.answers}, ${path}::text[], ${JSON.stringify(value)}::jsonb, true)`,
        state:
          value === null
            ? sql`jsonb_set(${interviews.state}, '{answers}', (${interviews.state} -> 'answers') - ${variable}, true)`
            : sql`jsonb_set(${interviews.state}, ${statePath}::text[], ${JSON.stringify(value)}::jsonb, true)`,
        updatedAt: at,
      })
      .where(eq(interviews.id, interviewId));
  }

  async nextEventSeq(interviewId: string, deviceId: string) {
    const [{ next }] = (await this.ptx
      .select({ next: sql<number>`coalesce(max(${interviewAnswerEvents.seq}), 0)::int + 1` })
      .from(interviewAnswerEvents)
      .where(
        and(
          eq(interviewAnswerEvents.interviewId, interviewId),
          eq(interviewAnswerEvents.deviceId, deviceId),
        ),
      )) as [{ next: number }];
    return next;
  }

  async openMismatches(secondInterviewId: string) {
    const [left] = await this.ptx
      .select({ n: sql<number>`count(*)::int` })
      .from(entryMismatches)
      .where(
        and(
          eq(entryMismatches.secondInterviewId, secondInterviewId),
          eq(entryMismatches.status, 'open'),
        ),
      );
    return left!.n;
  }

  async insertBatch(v: { projectId: string; uploadedBy: string; fileName: string; pdf: Buffer }) {
    const [b] = await this.ptx
      .insert(papiScanBatches)
      .values({ tenantId: this.pten, ...v })
      .returning({ id: papiScanBatches.id });
    return b!.id;
  }

  async claimBatch(id: string) {
    const [b] = await this.ptx
      .update(papiScanBatches)
      .set({
        status: 'running',
        startedAt: new Date(),
        attempts: sql`${papiScanBatches.attempts} + 1`,
      })
      .where(and(eq(papiScanBatches.id, id), claimable(papiScanBatches)))
      .returning();
    return b ?? null;
  }

  async failBatch(id: string, error: string) {
    await this.ptx
      .update(papiScanBatches)
      .set({ status: 'failed', error, finishedAt: new Date() })
      .where(eq(papiScanBatches.id, id));
  }

  async finishBatch(id: string, pages: number) {
    await this.ptx
      .update(papiScanBatches)
      .set({ status: 'done', pages, pdf: null, finishedAt: new Date() })
      .where(eq(papiScanBatches.id, id));
  }

  async caseInProject(projectId: string, id: string) {
    const [c] = await this.ptx
      .select()
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.projectId, projectId)));
    return c ?? null;
  }

  async insertForm(v: NewForm) {
    await this.ptx.insert(papiScanForms).values({ tenantId: this.pten, ...v });
  }

  async insertPages(rows: NewPage[]) {
    for (const r of rows)
      await this.ptx.insert(papiScanPages).values({ tenantId: this.pten, ...r } as never);
  }

  async hasTakenInterview(caseId: string) {
    const [taken] = await this.ptx
      .select({ id: interviews.id })
      .from(interviews)
      .where(
        and(
          eq(interviews.caseId, caseId),
          inArray(interviews.status, ['in_progress', 'submitted', 'in_review', 'approved']),
        ),
      )
      .limit(1);
    return !!taken;
  }

  batches(projectId: string) {
    return this.ptx
      .select({
        id: papiScanBatches.id,
        fileName: papiScanBatches.fileName,
        status: papiScanBatches.status,
        pages: papiScanBatches.pages,
        error: papiScanBatches.error,
        createdAt: papiScanBatches.createdAt,
        uploadedBy: users.name,
      })
      .from(papiScanBatches)
      .leftJoin(users, eq(users.id, papiScanBatches.uploadedBy))
      .where(eq(papiScanBatches.projectId, projectId))
      .orderBy(desc(papiScanBatches.createdAt))
      .limit(50);
  }

  scanForms(batchIds: string[]) {
    return this.ptx
      .select({
        id: papiScanForms.id,
        batchId: papiScanForms.batchId,
        caseId: papiScanForms.caseId,
        externalId: cases.externalId,
        interviewId: papiScanForms.interviewId,
        status: papiScanForms.status,
        pagesExpected: papiScanForms.pagesExpected,
        pagesFound: papiScanForms.pagesFound,
        issues: papiScanForms.issues,
        interviewStatus: interviews.status,
      })
      .from(papiScanForms)
      .innerJoin(cases, eq(cases.id, papiScanForms.caseId))
      .leftJoin(interviews, eq(interviews.id, papiScanForms.interviewId))
      .where(inArray(papiScanForms.batchId, batchIds))
      .orderBy(asc(cases.externalId));
  }

  strayPages(batchIds: string[]) {
    return this.ptx
      .select({
        batchId: papiScanPages.batchId,
        pageNo: papiScanPages.pageNo,
        problem: papiScanPages.problem,
      })
      .from(papiScanPages)
      .where(
        and(inArray(papiScanPages.batchId, batchIds), sql`${papiScanPages.problem} is not null`),
      )
      .orderBy(asc(papiScanPages.pageNo));
  }

  async formOfInterview(interviewId: string) {
    const [form] = await this.ptx
      .select()
      .from(papiScanForms)
      .where(eq(papiScanForms.interviewId, interviewId));
    return form ?? null;
  }

  async formOf(projectId: string, id: string) {
    const [form] = await this.ptx
      .select()
      .from(papiScanForms)
      .where(and(eq(papiScanForms.id, id), eq(papiScanForms.projectId, projectId)));
    return form ?? null;
  }

  formPages(formId: string) {
    return this.ptx
      .select({
        id: papiScanPages.id,
        formPage: papiScanPages.formPage,
        transform: papiScanPages.transform,
        width: papiScanPages.width,
        height: papiScanPages.height,
      })
      .from(papiScanPages)
      .where(eq(papiScanPages.formId, formId))
      .orderBy(asc(papiScanPages.formPage));
  }

  async pageImage(projectId: string, pageId: string) {
    const [p] = await this.ptx
      .select({ image: papiScanPages.image })
      .from(papiScanPages)
      .innerJoin(papiScanBatches, eq(papiScanBatches.id, papiScanPages.batchId))
      .where(and(eq(papiScanPages.id, pageId), eq(papiScanBatches.projectId, projectId)));
    return p?.image ?? null;
  }

  async claimInterview(interviewId: string, userId: string) {
    const [row] = await this.ptx
      .update(interviews)
      .set({ interviewerId: userId, updatedAt: new Date() })
      .where(and(eq(interviews.id, interviewId), eq(interviews.status, 'in_progress')))
      .returning({ id: interviews.id });
    return row?.id ?? null;
  }

  async assignCase(caseId: string, userId: string) {
    await this.ptx
      .update(cases)
      .set({ assignedTo: userId, updatedAt: new Date() })
      .where(eq(cases.id, caseId));
  }

  async questionnaireName(id: string) {
    const [q] = await this.ptx
      .select({ name: questionnaires.name })
      .from(questionnaires)
      .where(eq(questionnaires.id, id));
    return q?.name ?? null;
  }

  async versionIdOf(questionnaireId: string, version: number) {
    const [v] = await this.ptx
      .select({ id: questionnaireVersions.id })
      .from(questionnaireVersions)
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, questionnaireId),
          eq(questionnaireVersions.version, version),
        ),
      );
    return v?.id ?? null;
  }
}

@Injectable()
export class PgPapiRepo implements PapiRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: PapiTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) => fn(new PgPapiTx(tx, tenantId, this.audits)));
  }

  extend(t: InterviewsTx): PapiTx {
    const h = t.handle();
    if (h.kind !== 'pg') throw new Error('Not a PostgreSQL transaction');
    return new PgPapiTx(h.tx, h.tenantId, this.audits);
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const lowOrNull = (s: string | null) => (s === null ? null : s.toLowerCase());
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function toMismatch(r: Record<string, unknown>): MismatchRow {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    caseId: low(r.case_id as string),
    firstInterviewId: low(r.first_interview_id as string),
    secondInterviewId: low(r.second_interview_id as string),
    variable: g('variable'),
    firstValue: parse(r.first_value as string | null),
    secondValue: parse(r.second_value as string | null),
    status: g('status'),
    resolvedValue: parse(r.resolved_value as string | null),
    resolvedBy: lowOrNull((r.resolved_by as string | null) ?? null),
    resolvedAt: g('resolved_at'),
    createdAt: g('created_at'),
  } as unknown as MismatchRow;
}

function toBatch(r: Record<string, unknown>): BatchView {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    uploadedBy: lowOrNull((r.uploaded_by as string | null) ?? null),
    fileName: g('file_name'),
    pdf: g('pdf'),
    status: g('status'),
    pages: g('pages'),
    error: g('error'),
    createdAt: g('created_at'),
    finishedAt: g('finished_at'),
    startedAt: g('started_at'),
    attempts: g('attempts'),
  } as unknown as BatchView;
}

function toForm(r: Record<string, unknown>): FormView {
  const g = (k: string) => r[k] as never;
  return {
    id: low(r.id as string),
    tenantId: low(r.tenant_id as string),
    projectId: low(r.project_id as string),
    batchId: low(r.batch_id as string),
    caseId: low(r.case_id as string),
    questionnaireVersionId: low(r.questionnaire_version_id as string),
    lang: g('lang'),
    interviewId: lowOrNull((r.interview_id as string | null) ?? null),
    status: g('status'),
    pagesExpected: g('pages_expected'),
    pagesFound: parse(r.pages_found as string),
    issues: parse(r.issues as string),
    createdAt: g('created_at'),
    updatedAt: g('updated_at'),
  } as unknown as FormView;
}

export class MssqlPapiTx extends MssqlInterviewsTx implements PapiTx {
  constructor(
    private readonly pmtx: MssqlTx,
    private readonly pmten: string,
    cstore: CasesStore,
    istore: InterviewsStore,
  ) {
    super(pmtx, pmten, cstore, istore);
  }

  async formCases(
    projectId: string,
    q: { userId: string | null; caseIds?: string[]; questionnaireId?: string },
  ) {
    const res = await ksql<Record<string, unknown>>`
      SELECT id, external_id, sample, sample_pii, status, priority, mode_preference, assigned_to
      FROM dbo.cases
      WHERE project_id = ${projectId}
        ${q.userId ? ksql`AND assigned_to = ${q.userId}` : ksql``}
        ${
          q.caseIds?.length
            ? ksql`AND id IN (SELECT value FROM OPENJSON(${JSON.stringify(q.caseIds)}))`
            : ksql``
        }
        ${
          q.questionnaireId
            ? ksql`AND (questionnaire_id IS NULL OR questionnaire_id = ${q.questionnaireId})`
            : ksql``
        }
      ORDER BY external_id`.execute(this.pmtx);
    return res.rows.map((r) => ({
      id: low(r.id as string),
      externalId: r.external_id as string,
      sample: parse(r.sample as string),
      samplePii: (r.sample_pii as string | null) ?? null,
      status: r.status as string,
      priority: r.priority as number,
      modePreference: (r.mode_preference as string | null) ?? null,
      assignedTo: lowOrNull((r.assigned_to as string | null) ?? null),
    }));
  }

  async paperInterviews(caseId: string) {
    const res = await ksql<{ id: string }>`
      SELECT id FROM dbo.interviews WHERE case_id = ${caseId} AND mode = 'PAPI'
      ORDER BY started_at DESC`.execute(this.pmtx);
    const out: InterviewRow[] = [];
    for (const r of res.rows) {
      const row = await this.interview(low(r.id));
      if (row) out.push(row);
    }
    return out;
  }

  async caseByExternalId(projectId: string, externalId: string) {
    const c = await this.pmtx
      .selectFrom('cases')
      .select(['id', 'external_id', 'status', 'assigned_to'])
      .where('project_id', '=', projectId)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return c
      ? {
          id: low(c.id),
          externalId: c.external_id,
          status: c.status,
          assignedTo: lowOrNull(c.assigned_to),
        }
      : null;
  }

  async reopenCase(caseId: string) {
    await this.pmtx
      .updateTable('cases')
      .set({
        status: 'in_progress',
        disposition: null,
        updated_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', caseId)
      .execute();
  }

  async firstEntry(caseId: string, statuses: string[]) {
    const r = await this.pmtx
      .selectFrom('interviews')
      .select('id')
      .where('case_id', '=', caseId)
      .where('mode', '=', 'PAPI')
      .where('entry_pass', '=', 1)
      .where('status', 'in', statuses)
      .top(1)
      .executeTakeFirst();
    return r ? this.interview(low(r.id)) : null;
  }

  async insertMismatches(rows: Parameters<PapiTx['insertMismatches']>[0]) {
    const first = rows[0];
    if (!first) return;
    const items = rows.map((r) => ({
      id: randomUUID(),
      variable: r.variable,
      first: json(r.firstValue),
      second: json(r.secondValue),
    }));
    await ksql`
      INSERT INTO dbo.entry_mismatches (id, tenant_id, project_id, case_id, first_interview_id,
        second_interview_id, variable, first_value, second_value)
      SELECT j.id, ${this.pmten}, ${first.projectId}, ${first.caseId}, ${first.firstInterviewId},
        ${first.secondInterviewId}, j.variable, j.first, j.second
      FROM OPENJSON(${JSON.stringify(items)}) WITH (
        id uniqueidentifier, variable nvarchar(450), [first] nvarchar(max), [second] nvarchar(max)
      ) j`.execute(this.pmtx);
  }

  async mismatches(projectId: string, status: 'open' | 'resolved' | 'all') {
    const res = await ksql<Record<string, unknown>>`
      SELECT TOP (1000) m.id, m.case_id, c.external_id, m.variable, m.first_value, m.second_value,
        m.status, m.resolved_value, u.name AS resolver, m.resolved_at, m.first_interview_id,
        i.questionnaire_version_id
      FROM dbo.entry_mismatches m
      JOIN dbo.cases c ON c.id = m.case_id
      JOIN dbo.interviews i ON i.id = m.first_interview_id
      LEFT JOIN dbo.users u ON u.id = m.resolved_by
      WHERE m.project_id = ${projectId} ${status === 'all' ? ksql`` : ksql`AND m.status = ${status}`}
      ORDER BY c.external_id, m.variable`.execute(this.pmtx);
    return res.rows.map((r) => ({
      id: low(r.id as string),
      caseId: low(r.case_id as string),
      externalId: r.external_id as string,
      variable: r.variable as string,
      firstValue: parse(r.first_value as string | null),
      secondValue: parse(r.second_value as string | null),
      status: r.status as string,
      resolvedValue: parse(r.resolved_value as string | null),
      resolvedBy: (r.resolver as string | null) ?? null,
      resolvedAt: (r.resolved_at as Date | null) ?? null,
      firstInterviewId: low(r.first_interview_id as string),
      questionnaireVersionId: low(r.questionnaire_version_id as string),
    }));
  }

  async lockMismatch(projectId: string, id: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT * FROM dbo.entry_mismatches WITH (UPDLOCK, ROWLOCK)
      WHERE id = ${id} AND project_id = ${projectId}`.execute(this.pmtx);
    return res.rows[0] ? toMismatch(res.rows[0]) : null;
  }

  async resolveMismatch(id: string, v: { value: unknown; by: string; at: Date }) {
    await this.pmtx
      .updateTable('entry_mismatches')
      .set({
        status: 'resolved',
        resolved_value: json(v.value),
        resolved_by: v.by,
        resolved_at: instant(v.at),
      })
      .where('id', '=', id)
      .execute();
  }

  async overwriteAnswer(interviewId: string, variable: string, value: unknown, at: Date) {
    // The row is locked by the caller's transaction; the documents are edited here.
    const row = await this.interview(interviewId, true);
    if (!row) return;
    const answers = { ...((row.answers ?? {}) as Record<string, unknown>) };
    const state = { ...((row.state ?? {}) as Record<string, unknown>) };
    const stateAnswers = { ...((state.answers ?? {}) as Record<string, unknown>) };
    if (value === null) {
      delete answers[variable];
      delete stateAnswers[variable];
    } else {
      answers[variable] = value;
      stateAnswers[variable] = value;
    }
    if (state.answers !== undefined || value !== null) state.answers = stateAnswers;
    await this.pmtx
      .updateTable('interviews')
      .set({
        answers: JSON.stringify(answers),
        state: JSON.stringify(state),
        updated_at: instant(at),
      })
      .where('id', '=', interviewId)
      .execute();
  }

  async nextEventSeq(interviewId: string, deviceId: string) {
    const res = await ksql<{ n: number }>`
      SELECT ISNULL(MAX(seq), 0) + 1 AS n FROM dbo.interview_answer_events
      WHERE interview_id = ${interviewId} AND device_id = ${deviceId}`.execute(this.pmtx);
    return Number(res.rows[0]!.n);
  }

  async openMismatches(secondInterviewId: string) {
    const res = await ksql<{ n: number }>`
      SELECT COUNT(*) AS n FROM dbo.entry_mismatches
      WHERE second_interview_id = ${secondInterviewId} AND status = 'open'`.execute(this.pmtx);
    return Number(res.rows[0]!.n);
  }

  async insertBatch(v: { projectId: string; uploadedBy: string; fileName: string; pdf: Buffer }) {
    const id = randomUUID();
    await this.pmtx
      .insertInto('papi_scan_batches')
      .values({
        id,
        tenant_id: this.pmten,
        project_id: v.projectId,
        uploaded_by: v.uploadedBy,
        file_name: v.fileName,
        pdf: v.pdf,
        error: null,
        finished_at: null,
        started_at: null,
      })
      .execute();
    return id;
  }

  async claimBatch(id: string) {
    const ok = await claimJob(this.pmtx, 'papi_scan_batches', id, {
      maxAttempts: MAX_JOB_ATTEMPTS,
      stuckMs: STUCK_AFTER_MS,
    });
    if (!ok) return null;
    const r = await this.pmtx
      .selectFrom('papi_scan_batches')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toBatch(r as never) : null;
  }

  async failBatch(id: string, error: string) {
    await this.pmtx
      .updateTable('papi_scan_batches')
      .set({ status: 'failed', error, finished_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', id)
      .execute();
  }

  async finishBatch(id: string, pages: number) {
    await this.pmtx
      .updateTable('papi_scan_batches')
      .set({
        status: 'done',
        pages,
        pdf: ksql<Buffer>`CAST(NULL AS varbinary(max))`,
        finished_at: ksql<Date>`SYSDATETIMEOFFSET()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async caseInProject(projectId: string, id: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT * FROM dbo.cases WHERE id = ${id} AND project_id = ${projectId}`.execute(this.pmtx);
    return res.rows[0] ? toCase(res.rows[0] as never) : null;
  }

  async insertForm(v: NewForm) {
    await this.pmtx
      .insertInto('papi_scan_forms')
      .values({
        id: v.id,
        tenant_id: this.pmten,
        project_id: v.projectId,
        batch_id: v.batchId,
        case_id: v.caseId,
        questionnaire_version_id: v.questionnaireVersionId,
        lang: v.lang,
        interview_id: v.interviewId ?? null,
        status: v.status,
        pages_expected: v.pagesExpected,
        pages_found: JSON.stringify(v.pagesFound),
        issues: JSON.stringify(v.issues),
      })
      .execute();
  }

  async insertPages(rows: NewPage[]) {
    // Images are large: one statement each keeps a request small.
    for (const p of rows)
      await this.pmtx
        .insertInto('papi_scan_pages')
        .values({
          id: randomUUID(),
          tenant_id: this.pmten,
          batch_id: p.batchId,
          form_id: p.formId,
          page_no: p.pageNo,
          form_page: p.formPage,
          problem: p.problem,
          transform: json(p.transform),
          width: p.width,
          height: p.height,
          image: p.image,
        })
        .execute();
  }

  async hasTakenInterview(caseId: string) {
    const r = await this.pmtx
      .selectFrom('interviews')
      .select('id')
      .where('case_id', '=', caseId)
      .where('status', 'in', ['in_progress', 'submitted', 'in_review', 'approved'])
      .top(1)
      .executeTakeFirst();
    return !!r;
  }

  async batches(projectId: string) {
    const res = await ksql<Record<string, unknown>>`
      SELECT TOP (50) b.id, b.file_name, b.status, b.pages, b.error, b.created_at, u.name AS uploader
      FROM dbo.papi_scan_batches b LEFT JOIN dbo.users u ON u.id = b.uploaded_by
      WHERE b.project_id = ${projectId}
      ORDER BY b.created_at DESC`.execute(this.pmtx);
    return res.rows.map((r) => ({
      id: low(r.id as string),
      fileName: r.file_name as string,
      status: r.status as string,
      pages: r.pages as number,
      error: (r.error as string | null) ?? null,
      createdAt: r.created_at as Date,
      uploadedBy: (r.uploader as string | null) ?? null,
    }));
  }

  async scanForms(batchIds: string[]) {
    const res = await ksql<Record<string, unknown>>`
      SELECT f.id, f.batch_id, f.case_id, c.external_id, f.interview_id, f.status,
        f.pages_expected, f.pages_found, f.issues, i.status AS interview_status
      FROM dbo.papi_scan_forms f
      JOIN dbo.cases c ON c.id = f.case_id
      LEFT JOIN dbo.interviews i ON i.id = f.interview_id
      WHERE f.batch_id IN (SELECT value FROM OPENJSON(${JSON.stringify(batchIds)}))
      ORDER BY c.external_id`.execute(this.pmtx);
    return res.rows.map((r) => ({
      id: low(r.id as string),
      batchId: low(r.batch_id as string),
      caseId: low(r.case_id as string),
      externalId: r.external_id as string,
      interviewId: lowOrNull((r.interview_id as string | null) ?? null),
      status: r.status as string,
      pagesExpected: r.pages_expected as number,
      pagesFound: parse<number[]>(r.pages_found as string),
      issues: parse(r.issues as string),
      interviewStatus: (r.interview_status as string | null) ?? null,
    }));
  }

  async strayPages(batchIds: string[]) {
    const res = await ksql<Record<string, unknown>>`
      SELECT batch_id, page_no, problem FROM dbo.papi_scan_pages
      WHERE batch_id IN (SELECT value FROM OPENJSON(${JSON.stringify(batchIds)}))
        AND problem IS NOT NULL
      ORDER BY page_no`.execute(this.pmtx);
    return res.rows.map((r) => ({
      batchId: low(r.batch_id as string),
      pageNo: r.page_no as number,
      problem: (r.problem as string | null) ?? null,
    }));
  }

  async formOfInterview(interviewId: string) {
    const r = await this.pmtx
      .selectFrom('papi_scan_forms')
      .selectAll()
      .where('interview_id', '=', interviewId)
      .executeTakeFirst();
    return r ? toForm(r as never) : null;
  }

  async formOf(projectId: string, id: string) {
    const r = await this.pmtx
      .selectFrom('papi_scan_forms')
      .selectAll()
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return r ? toForm(r as never) : null;
  }

  async formPages(formId: string) {
    const rows = await this.pmtx
      .selectFrom('papi_scan_pages')
      .select(['id', 'form_page', 'transform', 'width', 'height'])
      .where('form_id', '=', formId)
      .orderBy('form_page')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      formPage: r.form_page,
      transform: parse<unknown>(r.transform),
      width: r.width,
      height: r.height,
    }));
  }

  async pageImage(projectId: string, pageId: string) {
    const r = await this.pmtx
      .selectFrom('papi_scan_pages as p')
      .innerJoin('papi_scan_batches as b', 'b.id', 'p.batch_id')
      .select('p.image')
      .where('p.id', '=', pageId)
      .where('b.project_id', '=', projectId)
      .executeTakeFirst();
    return r?.image ?? null;
  }

  async claimInterview(interviewId: string, userId: string) {
    const res = await ksql<{ id: string }>`
      UPDATE dbo.interviews SET interviewer_id = ${userId}, updated_at = SYSDATETIMEOFFSET()
      OUTPUT inserted.id
      WHERE id = ${interviewId} AND status = 'in_progress'`.execute(this.pmtx);
    return res.rows[0] ? low(res.rows[0].id) : null;
  }

  async assignCase(caseId: string, userId: string) {
    await this.pmtx
      .updateTable('cases')
      .set({ assigned_to: userId, updated_at: ksql<Date>`SYSDATETIMEOFFSET()` })
      .where('id', '=', caseId)
      .execute();
  }

  async questionnaireName(id: string) {
    const q = await this.pmtx
      .selectFrom('questionnaires')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst();
    return q?.name ?? null;
  }

  async versionIdOf(questionnaireId: string, version: number) {
    const v = await this.pmtx
      .selectFrom('questionnaire_versions')
      .select('id')
      .where('questionnaire_id', '=', questionnaireId)
      .where('version', '=', version)
      .executeTakeFirst();
    return v ? low(v.id) : null;
  }
}

@Injectable()
export class MssqlPapiRepo implements PapiRepo {
  private readonly cstore = new CasesStore();
  private readonly istore = new InterviewsStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: PapiTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlPapiTx(tx, tenantId, this.cstore, this.istore)),
    );
  }

  extend(t: InterviewsTx): PapiTx {
    const h = t.handle();
    if (h.kind !== 'mssql') throw new Error('Not a SQL Server transaction');
    return new MssqlPapiTx(h.tx, h.tenantId, this.cstore, this.istore);
  }
}

export const PAPI_REPO = Symbol('PAPI_REPO');
