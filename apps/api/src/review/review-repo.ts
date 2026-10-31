import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { sql as ksql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { CasesStore } from '../cases/cases-store.mssql.js';
import { COUNTED_SQL } from '../common/statuses.js';
import { Database, Prepared, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import {
  cases,
  codedTexts,
  interviewParadata,
  interviews,
  openCodes,
  reviewComments,
  users,
} from '../db/schema.js';
import {
  MssqlInterviewsTx,
  PgInterviewsTx,
  type InterviewsTx,
} from '../interviews/interviews-repo.js';
import { InterviewsStore } from '../interviews/interviews-store.mssql.js';
import { ReviewStore } from './review-store.mssql.js';

/**
 * The database side of answer review, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`). A transaction here is also an `InterviewsTx`.
 */
export interface ReviewQuery {
  status: string[];
  interviewerId?: string;
  mode?: string;
  flag?: string;
  sampled?: boolean;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface CommentRow {
  id: string;
  variable: string | null;
  body: string;
  author: string | null;
  authorId: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface OtherText {
  key: string;
  value: string;
  interview_id: string;
}

export interface ReviewTx extends InterviewsTx {
  queue(
    projectId: string,
    q: ReviewQuery,
  ): Promise<{
    total: number;
    rows: {
      id: string;
      externalId: string | null;
      interviewer: string | null;
      interviewerId: string | null;
      mode: string;
      status: string;
      disposition: string | null;
      submittedAt: Date | null;
      activeMs: number;
      flags: unknown;
      sampled: boolean;
      submissions: number;
      comments: number;
    }[];
  }>;
  externalIdOf(caseId: string): Promise<string | null>;
  paradataOf(
    interviewId: string,
    types: string[],
  ): Promise<{ type: string; payload: unknown; at: Date }[]>;
  comments(interviewId: string): Promise<CommentRow[]>;
  addComment(v: {
    interviewId: string;
    variable: string | null;
    body: string;
    authorId: string;
  }): Promise<void>;
  comment(id: string): Promise<{ id: string; interviewId: string; resolvedAt: Date | null } | null>;
  setResolved(id: string, at: Date | null): Promise<void>;
  setReviewStatus(id: string, status: string, userId: string, now: Date): Promise<void>;
  /** After a return: the case is being worked again. */
  caseInProgress(caseId: string, now: Date): Promise<void>;
  /** After a rejection that reopens the case: fresh or assigned, without a result. */
  reopenCase(caseId: string, now: Date): Promise<void>;
  setCaseDisposition(caseId: string, disposition: string | null, now: Date): Promise<void>;
  submitCounts(interviewId: string): Promise<{ warnings: number; differences: number }>;
  /** The next change number under the review device. */
  nextReviewSeq(interviewId: string): Promise<number>;
  saveCorrection(
    id: string,
    v: {
      state: unknown;
      answers: Record<string, unknown>;
      stateVersion: number;
      stateDevice: string;
      disposition: string | null;
      now: Date;
    },
  ): Promise<void>;
  returnedTo(
    projectId: string,
    userId: string,
  ): Promise<
    {
      id: string;
      externalId: string | null;
      mode: string;
      reviewedAt: Date | null;
      reviewer: string | null;
      comment: string | null;
    }[]
  >;
  otherTexts(projectId: string, variable?: string): Promise<OtherText[]>;
  codedTexts(
    projectId: string,
    variable?: string,
  ): Promise<{ variable: string; text: string; code: number }[]>;
  codesOf(projectId: string, variable: string): Promise<{ code: number; label: string }[]>;
  /** Replaces the codes of a variable; the codes in use that would go are returned instead. */
  saveCodeList(
    projectId: string,
    variable: string,
    codes: { code: number; label: string }[],
  ): Promise<{ inUse: number[] }>;
  codeExists(projectId: string, variable: string, code: number): Promise<boolean>;
  /** Codes (or removes the code of) texts and writes it to the interviews with them. */
  assignCode(v: {
    projectId: string;
    variable: string;
    keys: string[];
    code: number | null;
    userId: string;
  }): Promise<number>;
}

export interface ReviewRepo {
  inTenant<T>(tenantId: string, fn: (t: ReviewTx) => Promise<T>): Promise<T>;
  extend(t: InterviewsTx): ReviewTx;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

const submitCountsQ = new Prepared<{ warnings: number; differences: number }>(
  () => sql`
    select
      (select count(*)::int from interview_paradata
        where interview_id = ${sql.placeholder('id')} and type = 'warning_confirmed') as warnings,
      (select count(*)::int from entry_mismatches
        where second_interview_id = ${sql.placeholder('id')}) as differences`,
  { warnings: 'raw', differences: 'raw' },
);

const REVIEW_DEVICE = 'review';

export class PgReviewTx extends PgInterviewsTx implements ReviewTx {
  constructor(
    private readonly rtx: Tx,
    private readonly rt: string,
    audits: AuditService,
  ) {
    super(rtx, rt, audits);
  }

  async queue(projectId: string, q: ReviewQuery) {
    const conds: SQL[] = [
      eq(interviews.projectId, projectId),
      inArray(interviews.status, q.status),
    ];
    if (q.interviewerId) conds.push(eq(interviews.interviewerId, q.interviewerId));
    if (q.mode) conds.push(eq(interviews.mode, q.mode));
    if (q.flag) conds.push(sql`${interviews.flags} ? ${q.flag}`);
    if (q.sampled !== undefined) conds.push(eq(interviews.sampled, q.sampled));
    if (q.from) conds.push(gte(interviews.submittedAt, new Date(`${q.from}T00:00:00Z`)));
    if (q.to) conds.push(lte(interviews.submittedAt, new Date(`${q.to}T23:59:59.999Z`)));
    const where = and(...conds);
    const [total] = await this.rtx
      .select({ n: sql<number>`count(*)::int` })
      .from(interviews)
      .where(where);
    const rows = await this.rtx
      .select({
        id: interviews.id,
        externalId: cases.externalId,
        interviewer: users.name,
        interviewerId: interviews.interviewerId,
        mode: interviews.mode,
        status: interviews.status,
        disposition: interviews.disposition,
        submittedAt: interviews.submittedAt,
        activeMs: interviews.activeMs,
        flags: interviews.flags,
        sampled: interviews.sampled,
        submissions: interviews.submissions,
        comments: sql<number>`(select count(*)::int from review_comments rc where rc.interview_id = ${interviews.id})`,
      })
      .from(interviews)
      .leftJoin(cases, eq(cases.id, interviews.caseId))
      .leftJoin(users, eq(users.id, interviews.interviewerId))
      .where(where)
      .orderBy(desc(interviews.submittedAt), asc(interviews.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
    return { total: total?.n ?? 0, rows };
  }

  async externalIdOf(caseId: string) {
    const [c] = await this.rtx
      .select({ externalId: cases.externalId })
      .from(cases)
      .where(eq(cases.id, caseId));
    return c?.externalId ?? null;
  }

  paradataOf(interviewId: string, types: string[]) {
    return this.rtx
      .select({
        type: interviewParadata.type,
        payload: interviewParadata.payload,
        at: interviewParadata.at,
      })
      .from(interviewParadata)
      .where(
        and(eq(interviewParadata.interviewId, interviewId), inArray(interviewParadata.type, types)),
      )
      .orderBy(asc(interviewParadata.at));
  }

  comments(interviewId: string) {
    return this.rtx
      .select({
        id: reviewComments.id,
        variable: reviewComments.variable,
        body: reviewComments.body,
        author: users.name,
        authorId: reviewComments.authorId,
        createdAt: reviewComments.createdAt,
        resolvedAt: reviewComments.resolvedAt,
      })
      .from(reviewComments)
      .leftJoin(users, eq(users.id, reviewComments.authorId))
      .where(eq(reviewComments.interviewId, interviewId))
      .orderBy(asc(reviewComments.createdAt));
  }

  async addComment(v: {
    interviewId: string;
    variable: string | null;
    body: string;
    authorId: string;
  }) {
    await this.rtx.insert(reviewComments).values({ tenantId: this.rt, ...v });
  }

  async comment(id: string) {
    const [c] = await this.rtx.select().from(reviewComments).where(eq(reviewComments.id, id));
    return c ?? null;
  }

  async setResolved(id: string, at: Date | null) {
    await this.rtx.update(reviewComments).set({ resolvedAt: at }).where(eq(reviewComments.id, id));
  }

  async setReviewStatus(id: string, status: string, userId: string, now: Date) {
    await this.rtx
      .update(interviews)
      .set({ status, reviewedBy: userId, reviewedAt: now, updatedAt: now })
      .where(eq(interviews.id, id));
  }

  async caseInProgress(caseId: string, now: Date) {
    await this.rtx
      .update(cases)
      .set({ status: 'in_progress', updatedAt: now })
      .where(eq(cases.id, caseId));
  }

  async reopenCase(caseId: string, now: Date) {
    await this.rtx
      .update(cases)
      .set({
        status: sql`case when ${cases.assignedTo} is null then 'fresh' else 'assigned' end`,
        disposition: null,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId));
  }

  async setCaseDisposition(caseId: string, disposition: string | null, now: Date) {
    await this.rtx.update(cases).set({ disposition, updatedAt: now }).where(eq(cases.id, caseId));
  }

  async submitCounts(interviewId: string) {
    const [c] = await submitCountsQ.run(this.rtx, { id: interviewId });
    return { warnings: c?.warnings ?? 0, differences: c?.differences ?? 0 };
  }

  async nextReviewSeq(interviewId: string) {
    const res = (await this.rtx.execute(sql`
      select coalesce(max(seq), 0)::int as n from interview_answer_events
      where interview_id = ${interviewId} and device_id = ${REVIEW_DEVICE}`)) as unknown as {
      n: number;
    }[];
    return (res[0]?.n ?? 0) + 1;
  }

  async saveCorrection(id: string, v: Parameters<ReviewTx['saveCorrection']>[1]) {
    await this.rtx
      .update(interviews)
      .set({
        state: v.state as never,
        answers: v.answers,
        stateVersion: v.stateVersion,
        stateDevice: v.stateDevice,
        disposition: v.disposition,
        updatedAt: v.now,
      })
      .where(eq(interviews.id, id));
  }

  returnedTo(projectId: string, userId: string) {
    return this.rtx
      .select({
        id: interviews.id,
        externalId: cases.externalId,
        mode: interviews.mode,
        reviewedAt: interviews.reviewedAt,
        reviewer: users.name,
        comment: sql<
          string | null
        >`(select body from review_comments rc where rc.interview_id = ${interviews.id} order by rc.created_at desc limit 1)`,
      })
      .from(interviews)
      .leftJoin(cases, eq(cases.id, interviews.caseId))
      .leftJoin(users, eq(users.id, interviews.reviewedBy))
      .where(
        and(
          eq(interviews.projectId, projectId),
          eq(interviews.interviewerId, userId),
          eq(interviews.status, 'returned'),
        ),
      )
      .orderBy(desc(interviews.reviewedAt));
  }

  async otherTexts(projectId: string, variable?: string) {
    const rows = (await this.rtx.execute(sql`
      select a.key as key, a.value as value, i.id as interview_id
      from interviews i, jsonb_each_text(i.answers) a
      where i.project_id = ${projectId}
        and i.status in ${COUNTED_SQL}
        and a.key ~ '_OTHER$' and length(trim(a.value)) > 0`)) as unknown as OtherText[];
    const base = (key: string) =>
      key
        .replace(/\[\d+\]/g, '')
        .split('.')
        .pop()!;
    return rows.filter((r) => !variable || base(r.key) === variable);
  }

  codedTexts(projectId: string, variable?: string) {
    return this.rtx
      .select({ variable: codedTexts.variable, text: codedTexts.text, code: codedTexts.code })
      .from(codedTexts)
      .where(
        and(
          eq(codedTexts.projectId, projectId),
          variable ? eq(codedTexts.variable, variable) : undefined,
        ),
      );
  }

  codesOf(projectId: string, variable: string) {
    return this.rtx
      .select({ code: openCodes.code, label: openCodes.label })
      .from(openCodes)
      .where(and(eq(openCodes.projectId, projectId), eq(openCodes.variable, variable)))
      .orderBy(asc(openCodes.code));
  }

  async saveCodeList(
    projectId: string,
    variable: string,
    codes: { code: number; label: string }[],
  ) {
    const keep = codes.map((c) => c.code);
    const used = await this.rtx
      .select({ code: codedTexts.code })
      .from(codedTexts)
      .where(and(eq(codedTexts.projectId, projectId), eq(codedTexts.variable, variable)));
    const missing = used.filter((u) => !keep.includes(u.code));
    if (missing.length) return { inUse: [...new Set(missing.map((m) => m.code))] };
    await this.rtx
      .delete(openCodes)
      .where(and(eq(openCodes.projectId, projectId), eq(openCodes.variable, variable)));
    if (codes.length)
      await this.rtx
        .insert(openCodes)
        .values(codes.map((c) => ({ tenantId: this.rt, projectId, variable, ...c })));
    return { inUse: [] };
  }

  async codeExists(projectId: string, variable: string, code: number) {
    const [ok] = await this.rtx
      .select({ id: openCodes.id })
      .from(openCodes)
      .where(
        and(
          eq(openCodes.projectId, projectId),
          eq(openCodes.variable, variable),
          eq(openCodes.code, code),
        ),
      );
    return !!ok;
  }

  async assignCode(v: {
    projectId: string;
    variable: string;
    keys: string[];
    code: number | null;
    userId: string;
  }) {
    if (v.code === null)
      await this.rtx
        .delete(codedTexts)
        .where(
          and(
            eq(codedTexts.projectId, v.projectId),
            eq(codedTexts.variable, v.variable),
            inArray(codedTexts.text, v.keys),
          ),
        );
    else
      for (const text of v.keys)
        await this.rtx
          .insert(codedTexts)
          .values({
            tenantId: this.rt,
            projectId: v.projectId,
            variable: v.variable,
            text,
            code: v.code,
            codedBy: v.userId,
          })
          .onConflictDoUpdate({
            target: [codedTexts.projectId, codedTexts.variable, codedTexts.text],
            set: { code: v.code, codedBy: v.userId, codedAt: new Date() },
          });
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const hits = (await this.otherTexts(v.projectId, v.variable)).filter((t) =>
      v.keys.includes(norm(t.value)),
    );
    const now = new Date();
    let changed = 0;
    for (const h of hits) {
      const codeKey = h.key.replace(/_OTHER$/, '_CODE');
      const [iv] = await this.rtx
        .select({ answers: interviews.answers })
        .from(interviews)
        .where(eq(interviews.id, h.interview_id))
        .for('update');
      const old = (iv!.answers as Record<string, unknown>)[codeKey] ?? null;
      if (old === v.code) continue;
      const answers = { ...(iv!.answers as Record<string, unknown>) };
      if (v.code === null) delete answers[codeKey];
      else answers[codeKey] = v.code;
      await this.rtx
        .update(interviews)
        .set({ answers, updatedAt: now })
        .where(eq(interviews.id, h.interview_id));
      await this.insertAnswerEvents(h.interview_id, REVIEW_DEVICE, [
        {
          seq: await this.nextReviewSeq(h.interview_id),
          variable: codeKey,
          oldValue: old,
          newValue: v.code,
          at: now,
          byUserId: v.userId,
          source: 'reviewer',
          reason: 'coding',
        },
      ]);
      changed++;
    }
    return changed;
  }
}

@Injectable()
export class PgReviewRepo implements ReviewRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: ReviewTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) =>
      fn(new PgReviewTx(tx, tenantId, this.audits)),
    );
  }

  extend(t: InterviewsTx): ReviewTx {
    const h = t.handle();
    if (h.kind !== 'pg') throw new Error('Not a PostgreSQL transaction');
    return new PgReviewTx(h.tx, h.tenantId, this.audits);
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const low = (s: string) => s.toLowerCase();
const parse = <T>(text: string | null): T => (text === null ? (null as T) : JSON.parse(text));

export class MssqlReviewTx extends MssqlInterviewsTx implements ReviewTx {
  constructor(
    private readonly mtx: MssqlTx,
    private readonly tn: string,
    cstore: CasesStore,
    istore: InterviewsStore,
    private readonly review: ReviewStore,
  ) {
    super(mtx, tn, cstore, istore);
  }

  async queue(projectId: string, q: ReviewQuery) {
    const r = await this.review.queue(this.mtx, { projectId, ...q });
    return {
      total: r.total,
      rows: r.rows.map((x) => ({
        id: x.id,
        externalId: x.external_id,
        interviewer: x.interviewer,
        interviewerId: x.interviewer_id ? low(x.interviewer_id) : null,
        mode: x.mode,
        status: x.status,
        disposition: x.disposition,
        submittedAt: x.submitted_at,
        activeMs: x.active_ms,
        flags: x.flags,
        sampled: !!x.sampled,
        submissions: x.submissions,
        comments: x.comments,
      })),
    };
  }

  async externalIdOf(caseId: string) {
    const c = await this.mtx
      .selectFrom('cases')
      .select('external_id')
      .where('id', '=', caseId)
      .executeTakeFirst();
    return c?.external_id ?? null;
  }

  async paradataOf(interviewId: string, types: string[]) {
    const rows = await this.mtx
      .selectFrom('interview_paradata')
      .select(['type', 'payload', 'at'])
      .where('interview_id', '=', interviewId)
      .where('type', 'in', types)
      .orderBy('at')
      .execute();
    return rows.map((r) => ({
      type: r.type,
      payload: parse<unknown>(r.payload),
      at: r.at as Date,
    }));
  }

  async comments(interviewId: string) {
    const rows = await this.mtx
      .selectFrom('review_comments as c')
      .leftJoin('users as u', 'u.id', 'c.author_id')
      .select([
        'c.id',
        'c.variable',
        'c.body',
        'u.name as author',
        'c.author_id',
        'c.created_at',
        'c.resolved_at',
      ])
      .where('c.interview_id', '=', interviewId)
      .orderBy('c.created_at')
      .orderBy('c.id')
      .execute();
    return rows.map((r) => ({
      id: low(r.id),
      variable: r.variable,
      body: r.body,
      author: r.author,
      authorId: low(r.author_id),
      createdAt: r.created_at as Date,
      resolvedAt: r.resolved_at as Date | null,
    }));
  }

  async addComment(v: {
    interviewId: string;
    variable: string | null;
    body: string;
    authorId: string;
  }) {
    await this.review.addComment(this.mtx, {
      tenantId: this.tn,
      interviewId: v.interviewId,
      variable: v.variable,
      body: v.body,
      authorId: v.authorId,
    });
  }

  async comment(id: string) {
    const c = await this.mtx
      .selectFrom('review_comments')
      .select(['id', 'interview_id', 'resolved_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    return c
      ? {
          id: low(c.id),
          interviewId: low(c.interview_id),
          resolvedAt: c.resolved_at as Date | null,
        }
      : null;
  }

  async setResolved(id: string, at: Date | null) {
    await this.mtx
      .updateTable('review_comments')
      .set({ resolved_at: at ? instant(at) : null })
      .where('id', '=', id)
      .execute();
  }

  async setReviewStatus(id: string, status: string, userId: string, now: Date) {
    await this.mtx
      .updateTable('interviews')
      .set({
        status,
        reviewed_by: userId,
        reviewed_at: instant(now),
        updated_at: instant(now),
      })
      .where('id', '=', id)
      .execute();
  }

  caseInProgress(caseId: string) {
    return this.review.caseInProgress(this.mtx, caseId);
  }

  reopenCase(caseId: string) {
    return this.review.reopenCase(this.mtx, caseId);
  }

  setCaseDisposition(caseId: string, disposition: string | null) {
    return this.review.setCaseDisposition(this.mtx, caseId, disposition);
  }

  async submitCounts(interviewId: string) {
    const res = await ksql<{ warnings: number; differences: number }>`
      SELECT
        (SELECT COUNT(*) FROM dbo.interview_paradata
          WHERE interview_id = ${interviewId} AND type = 'warning_confirmed') AS warnings,
        (SELECT COUNT(*) FROM dbo.entry_mismatches
          WHERE second_interview_id = ${interviewId}) AS differences`.execute(this.mtx);
    return { warnings: res.rows[0]?.warnings ?? 0, differences: res.rows[0]?.differences ?? 0 };
  }

  async nextReviewSeq(interviewId: string) {
    const r = await this.mtx
      .selectFrom('interview_answer_events')
      .select(ksql<number>`COALESCE(MAX(seq), 0)`.as('n'))
      .where('interview_id', '=', interviewId)
      .where('device_id', '=', REVIEW_DEVICE)
      .executeTakeFirstOrThrow();
    return r.n + 1;
  }

  async saveCorrection(id: string, v: Parameters<ReviewTx['saveCorrection']>[1]) {
    await this.mtx
      .updateTable('interviews')
      .set({
        state: JSON.stringify(v.state),
        answers: JSON.stringify(v.answers),
        state_version: v.stateVersion,
        state_device: v.stateDevice,
        disposition: v.disposition,
        updated_at: instant(v.now),
      })
      .where('id', '=', id)
      .execute();
  }

  async returnedTo(projectId: string, userId: string) {
    const rows = await this.review.returnedTo(this.mtx, projectId, userId);
    return rows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      mode: r.mode,
      reviewedAt: r.reviewed_at as Date | null,
      reviewer: r.reviewer,
      comment: r.comment,
    }));
  }

  otherTexts(projectId: string, variable?: string) {
    return this.review.otherTexts(this.mtx, projectId, variable);
  }

  codedTexts(projectId: string, variable?: string) {
    return this.review.codedTexts(this.mtx, projectId, variable);
  }

  codesOf(projectId: string, variable: string) {
    return this.review.codes(this.mtx, projectId, variable);
  }

  saveCodeList(projectId: string, variable: string, codes: { code: number; label: string }[]) {
    return this.review.saveCodeList(this.mtx, { tenantId: this.tn, projectId, variable, codes });
  }

  async codeExists(projectId: string, variable: string, code: number) {
    const ok = await this.mtx
      .selectFrom('open_codes')
      .select('id')
      .where('project_id', '=', projectId)
      .where('variable', '=', variable)
      .where('code', '=', code)
      .executeTakeFirst();
    return !!ok;
  }

  assignCode(v: {
    projectId: string;
    variable: string;
    keys: string[];
    code: number | null;
    userId: string;
  }) {
    return this.review.assignCode(this.mtx, {
      tenantId: this.tn,
      projectId: v.projectId,
      variable: v.variable,
      texts: v.keys,
      code: v.code,
      userId: v.userId,
    });
  }
}

@Injectable()
export class MssqlReviewRepo implements ReviewRepo {
  private readonly cstore = new CasesStore();
  private readonly istore = new InterviewsStore();
  private readonly review = new ReviewStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: ReviewTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlReviewTx(tx, tenantId, this.cstore, this.istore, this.review)),
    );
  }

  extend(t: InterviewsTx): ReviewTx {
    const h = t.handle();
    if (h.kind !== 'mssql') throw new Error('Not a SQL Server transaction');
    return new MssqlReviewTx(h.tx, h.tenantId, this.cstore, this.istore, this.review);
  }
}

export const REVIEW_REPO = Symbol('REVIEW_REPO');
