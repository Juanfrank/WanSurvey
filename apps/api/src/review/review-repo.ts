import { Injectable } from '@nestjs/common';
import { sql as ksql } from 'kysely';
import { CasesStore } from '../cases/cases-store.mssql.js';

import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { instant } from '../db/mssql/instant.js';
import { MssqlInterviewsTx, type InterviewsTx } from '../interviews/interviews-repo.js';
import { InterviewsStore } from '../interviews/interviews-store.mssql.js';
import { REVIEW_DEVICE, ReviewStore } from './review-store.mssql.js';

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
    return new MssqlReviewTx(h.tx, h.tenantId, this.cstore, this.istore, this.review);
  }
}

export const REVIEW_REPO = Symbol('REVIEW_REPO');
