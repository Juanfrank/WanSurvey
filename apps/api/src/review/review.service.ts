import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { createInterview } from '@wansurvey/logic';
import type { Permission } from '@wansurvey/schema';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService, type AuditAction } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import { Prepared, type Tx } from '../db/database.js';
import {
  cases,
  codedTexts,
  interviewAnswerEvents,
  interviewParadata,
  interviews,
  openCodes,
  reviewComments,
  users,
} from '../db/schema.js';
import { MASK, maskContact, maskSample } from '../cases/case-logic.js';
import {
  InterviewsService,
  personalVariables,
  type InterviewRow,
} from '../interviews/interviews.service.js';
import { StatsService } from '../stats/stats.service.js';
import { FLAG_KINDS, computeFlags, inSample } from './flags.js';
import { COUNTED_SQL } from '../common/statuses.js';

export const QueueQuery = z.object({
  status: z
    .string()
    .default('submitted,in_review')
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(['submitted', 'in_review', 'approved', 'returned', 'rejected'])).min(1)),
  interviewerId: z.uuid().optional(),
  mode: z.enum(['CATI', 'CAPI', 'CAWI', 'PAPI']).optional(),
  flag: z.enum(FLAG_KINDS).optional(),
  sampled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const TransitionBody = z.strictObject({
  to: z.enum(['in_review', 'approved', 'returned', 'rejected']),
  comment: z.string().max(4000).optional(),
});

export const CorrectBody = z.strictObject({
  variable: z.string().min(1).max(200),
  value: z.unknown(),
  reason: z.string().min(3).max(500),
});

export const CommentBody = z.strictObject({
  variable: z.string().min(1).max(200).nullable().optional(),
  body: z.string().min(1).max(4000),
});

export const CodesBody = z.strictObject({
  codes: z
    .array(
      z.strictObject({
        code: z.number().int().min(1).max(99_999),
        label: z.string().min(1).max(200),
      }),
    )
    .max(500),
});

export const AssignBody = z.strictObject({
  texts: z.array(z.string().min(1).max(2000)).min(1).max(1000),
  code: z.number().int().min(1).max(99_999).nullable(),
});

type To = z.infer<typeof TransitionBody>['to'];

/** Who may move an interview from one status to another (R1). */
const TRANSITIONS: Record<string, Partial<Record<To, Permission>>> = {
  submitted: {
    in_review: 'interviews.review',
    returned: 'interviews.review',
    approved: 'interviews.approve',
    rejected: 'interviews.approve',
  },
  in_review: {
    returned: 'interviews.review',
    approved: 'interviews.approve',
    rejected: 'interviews.approve',
  },
  approved: { in_review: 'interviews.approve' },
};

const AUDIT: Record<To, AuditAction> = {
  in_review: 'interview.reviewed',
  approved: 'interview.approved',
  returned: 'interview.returned',
  rejected: 'interview.rejected',
};

/**
 * Answers rebuilt from the engine, with the codes given to "other" texts (`<VAR>_CODE`, which
 * the engine does not hold) kept while their text is unchanged. The sync does the same in SQL.
 */
export function keepCodes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(before ?? {})) {
    if (!k.endsWith('_CODE')) continue;
    const other = `${k.slice(0, -5)}_OTHER`;
    if (other in after && JSON.stringify(after[other]) === JSON.stringify(before[other]))
      out[k] = v;
  }
  return { ...out, ...after };
}

/** The device under which reviewers' changes are numbered. */
const REVIEW_DEVICE = 'review';
const REVIEWABLE = ['submitted', 'in_review'];
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const baseName = (key: string) =>
  key
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!;

/**
 * Answer review (spec §10.1; decisions R1–R6): quality flags and a random sample at every
 * submission, the review queue and screen, status changes, corrections that re-run the
 * logic, comment threads, and coding of "other" texts.
 */
/** Warnings confirmed and double-entry differences of an interview, in one query. */
const submitCounts = new Prepared<{ warnings: number; differences: number }>(
  () => sql`
    select
      (select count(*)::int from interview_paradata
        where interview_id = ${sql.placeholder('id')} and type = 'warning_confirmed') as warnings,
      (select count(*)::int from entry_mismatches
        where second_interview_id = ${sql.placeholder('id')}) as differences`,
  { warnings: 'raw', differences: 'raw' },
);

@Injectable()
export class ReviewService implements OnModuleInit {
  constructor(
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
    private readonly stats: StatsService,
  ) {}

  onModuleInit() {
    // The flags are written by the submission's own update.
    this.runtime.onSubmitting((tx, row) => this.flags(tx, row));
  }

  /** Flags and the sample, computed at each submission (R2, R3). */
  private async flags(tx: Tx, row: InterviewRow) {
    const settings = (await this.cases.settings(tx, row.projectId)).review;
    const compiled = await this.runtime.compiledOf(tx, row.questionnaireVersionId);
    const s = createInterview(compiled, {
      ...this.runtime.engineOptions(row),
      state: row.state as never,
    });
    const [c] = await submitCounts.run(tx, { id: row.id });
    const flags = computeFlags({
      compiled,
      answers: (row.answers ?? {}) as Record<string, unknown>,
      path: s.pathKeys(),
      activeMs: row.activeMs,
      warningsConfirmed: c?.warnings ?? 0,
      doubleEntryDifferences: c?.differences ?? 0,
      settings,
    });
    return { flags, sampled: inSample(row.id, settings.samplePercent) };
  }

  private reviewer(ctx: AuthContext, projectId: string) {
    return (
      can(ctx.memberships, 'interviews.review', projectId) ||
      can(ctx.memberships, 'interviews.approve', projectId)
    );
  }

  /** Interviews to review, newest submission first, with their flags (R2). */
  async queue(tx: Tx, projectId: string, q: z.infer<typeof QueueQuery>) {
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
    const [total] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(interviews)
      .where(where);
    const rows = await tx
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
    return { total: total?.n ?? 0, page: q.page, limit: q.limit, rows };
  }

  private async load(tx: Tx, id: string, lock = false) {
    const query = tx.select().from(interviews).where(eq(interviews.id, id));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException('Interview not found');
    return row;
  }

  /** Reviewers of the project, or the interviewer whose interview it is. */
  private async access(tx: Tx, ctx: AuthContext, id: string, lock = false) {
    const row = await this.load(tx, id, lock);
    const reviewer = this.reviewer(ctx, row.projectId);
    if (!reviewer && row.interviewerId !== ctx.userId)
      throw new NotFoundException('Interview not found');
    return { row, reviewer };
  }

  /** Everything the review screen shows (R4). */
  async detail(tx: Tx, ctx: AuthContext, id: string) {
    const { row, reviewer } = await this.access(tx, ctx, id);
    const compiled = await this.runtime.compiledOf(tx, row.questionnaireVersionId);
    const [c] = row.caseId
      ? await tx
          .select({ externalId: cases.externalId })
          .from(cases)
          .where(eq(cases.id, row.caseId))
      : [];
    const [who] = row.interviewerId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.interviewerId))
      : [];
    const para = await tx
      .select({
        type: interviewParadata.type,
        payload: interviewParadata.payload,
        at: interviewParadata.at,
      })
      .from(interviewParadata)
      .where(
        and(
          eq(interviewParadata.interviewId, id),
          inArray(interviewParadata.type, [
            'leave_question',
            'note_added',
            'warning_confirmed',
            'paper_meta',
          ]),
        ),
      )
      .orderBy(asc(interviewParadata.at));
    const timings: Record<string, number> = {};
    const notes: { key: string; text: string; at: Date }[] = [];
    const warnings: { key: string; ruleId: string }[] = [];
    let paper: unknown = null;
    for (const p of para) {
      const d = p.payload as Record<string, unknown>;
      if (p.type === 'leave_question' && typeof d.key === 'string')
        timings[d.key] = (timings[d.key] ?? 0) + Number(d.ms ?? 0);
      else if (p.type === 'note_added')
        notes.push({ key: String(d.key ?? ''), text: String(d.text ?? ''), at: p.at });
      else if (p.type === 'warning_confirmed')
        warnings.push({ key: String(d.key ?? ''), ruleId: String(d.ruleId ?? '') });
      else if (p.type === 'paper_meta') paper = d;
    }
    const history = await tx
      .select({
        variable: interviewAnswerEvents.variable,
        oldValue: interviewAnswerEvents.oldValue,
        newValue: interviewAnswerEvents.newValue,
        at: interviewAnswerEvents.at,
        source: interviewAnswerEvents.source,
        reason: interviewAnswerEvents.reason,
        by: users.name,
      })
      .from(interviewAnswerEvents)
      .leftJoin(users, eq(users.id, interviewAnswerEvents.byUserId))
      .where(eq(interviewAnswerEvents.interviewId, id))
      .orderBy(asc(interviewAnswerEvents.at), asc(interviewAnswerEvents.seq));
    // Without `pii.view`, personal case fields, contacts and answers to personal questions are
    // masked, as in the case's answer history.
    const canSee = this.cases.canSeePii(ctx, row.projectId);
    const personal = canSee ? new Set<string>() : personalVariables(compiled);
    const piiFields = canSee ? new Set<string>() : await this.cases.piiFields(tx, row.projectId);
    const isPersonal = (key: string) => personal.has(baseName(key).replace(/_OTHER$/, ''));
    const hide = (v: unknown) => (v === null || v === undefined ? v : MASK);
    const maskValues = (values: unknown) =>
      values && typeof values === 'object'
        ? Object.fromEntries(
            Object.entries(values).map(([k, v]) => [k, isPersonal(k) ? hide(v) : v]),
          )
        : values;
    const context = this.runtime.contextOf(row);
    const state = row.state as Record<string, unknown>;
    const allowed = reviewer
      ? (Object.entries(TRANSITIONS[row.status] ?? {}) as [To, Permission][])
          .filter(([, perm]) => can(ctx.memberships, perm, row.projectId))
          .map(([to]) => to)
      : [];
    return {
      interview: {
        id: row.id,
        projectId: row.projectId,
        caseId: row.caseId,
        externalId: c?.externalId ?? null,
        interviewer: who?.name ?? null,
        mode: row.mode,
        language: row.language,
        status: row.status,
        disposition: row.disposition,
        startedAt: row.startedAt,
        submittedAt: row.submittedAt,
        activeMs: row.activeMs,
        totalMs: row.totalMs,
        flags: row.flags,
        sampled: row.sampled,
        submissions: row.submissions,
        state: canSee
          ? state
          : { ...state, answers: maskValues(state.answers), stash: maskValues(state.stash) },
        entryPass: row.entryPass,
      },
      context: canSee
        ? context
        : {
            ...context,
            case: maskSample(context.case ?? {}, piiFields, false),
            ...(context.contacts
              ? { contacts: context.contacts.map((x) => maskContact(x, false)) }
              : {}),
          },
      compiled,
      timings,
      notes,
      warnings,
      paper,
      history: canSee
        ? history
        : history.map((h) =>
            isPersonal(h.variable)
              ? { ...h, oldValue: hide(h.oldValue), newValue: hide(h.newValue) }
              : h,
          ),
      comments: await this.comments(tx, id),
      allowed,
      canCorrect:
        REVIEWABLE.includes(row.status) &&
        can(ctx.memberships, 'interviews.correct', row.projectId),
      canComment: reviewer || row.status === 'returned',
    };
  }

  async comments(tx: Tx, id: string) {
    return tx
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
      .where(eq(reviewComments.interviewId, id))
      .orderBy(asc(reviewComments.createdAt));
  }

  async addComment(tx: Tx, ctx: AuthContext, id: string, body: z.infer<typeof CommentBody>) {
    const { row, reviewer } = await this.access(tx, ctx, id);
    if (!reviewer && row.status !== 'returned')
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Comments are closed' });
    await tx.insert(reviewComments).values({
      tenantId: ctx.tenantId,
      interviewId: id,
      variable: body.variable ?? null,
      body: body.body,
      authorId: ctx.userId,
    });
    return this.comments(tx, id);
  }

  async resolveComment(tx: Tx, ctx: AuthContext, commentId: string) {
    const [c] = await tx.select().from(reviewComments).where(eq(reviewComments.id, commentId));
    if (!c) throw new NotFoundException('Comment not found');
    await this.access(tx, ctx, c.interviewId);
    await tx
      .update(reviewComments)
      .set({ resolvedAt: c.resolvedAt ? null : new Date() })
      .where(eq(reviewComments.id, commentId));
    return this.comments(tx, c.interviewId);
  }

  /**
   * Moves an interview between review statuses (R1). Returning needs a comment and reopens
   * the interview for its interviewer; rejecting keeps it for the audit trail and, by
   * default, sends the case back to be interviewed again.
   */
  async transition(tx: Tx, ctx: AuthContext, id: string, body: z.infer<typeof TransitionBody>) {
    const row = await this.load(tx, id, true);
    const perm = TRANSITIONS[row.status]?.[body.to];
    if (!perm)
      throw new ConflictException({
        code: 'BAD_TRANSITION',
        message: `An interview that is ${row.status} cannot become ${body.to}`,
      });
    if (!can(ctx.memberships, perm, row.projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not do this' });
    if (body.to === 'returned') {
      if (!body.comment?.trim())
        throw new BadRequestException({
          code: 'COMMENT_REQUIRED',
          message: 'Say what the interviewer should fix',
        });
      if (!row.interviewerId)
        throw new ConflictException({
          code: 'NO_INTERVIEWER',
          message: 'Web interviews have no interviewer to return them to',
        });
    }
    const now = new Date();
    await tx
      .update(interviews)
      .set({ status: body.to, reviewedBy: ctx.userId, reviewedAt: now, updatedAt: now })
      .where(eq(interviews.id, id));
    if (body.comment?.trim())
      await tx.insert(reviewComments).values({
        tenantId: ctx.tenantId,
        interviewId: id,
        variable: null,
        body: body.comment.trim(),
        authorId: ctx.userId,
      });
    if (row.caseId) {
      const settings = (await this.cases.settings(tx, row.projectId)).review;
      if (body.to === 'returned')
        await tx
          .update(cases)
          .set({ status: 'in_progress', updatedAt: now })
          .where(eq(cases.id, row.caseId));
      if (body.to === 'rejected' && settings.rejectReopensCase)
        await tx
          .update(cases)
          .set({
            status: sql`case when ${cases.assignedTo} is null then 'fresh' else 'assigned' end`,
            disposition: null,
            updatedAt: now,
          })
          .where(eq(cases.id, row.caseId));
      await this.cases.events(tx, ctx.tenantId, ctx.userId, [
        {
          caseId: row.caseId,
          type: `interview_${body.to}`,
          details: { interviewId: id, ...(body.comment ? { comment: body.comment } : {}) },
        },
      ]);
    }
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: AUDIT[body.to],
        targetType: 'interview',
        targetId: id,
        details: { from: row.status, to: body.to },
      }),
    );
    if (row.submittedAt) await this.stats.touched(tx, row.tenantId, row.projectId, row.submittedAt);
    return { status: body.to };
  }

  private async nextReviewSeq(tx: Tx, id: string) {
    const [r] = await tx
      .select({ n: sql<number>`coalesce(max(${interviewAnswerEvents.seq}), 0)::int` })
      .from(interviewAnswerEvents)
      .where(
        and(
          eq(interviewAnswerEvents.interviewId, id),
          eq(interviewAnswerEvents.deviceId, REVIEW_DEVICE),
        ),
      );
    return (r?.n ?? 0) + 1;
  }

  /**
   * A reviewer's correction (R5): the value goes through the engine like any answer, so
   * validation runs and answers that fall off the path are cleared and recorded. A change
   * that would open questions with no answer is refused (return the interview instead).
   */
  async correct(tx: Tx, ctx: AuthContext, id: string, body: z.infer<typeof CorrectBody>) {
    const row = await this.load(tx, id, true);
    if (!can(ctx.memberships, 'interviews.correct', row.projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not correct answers' });
    if (!REVIEWABLE.includes(row.status))
      throw new ConflictException({
        code: 'NOT_IN_REVIEW',
        message: 'Only submitted interviews or those in review can be corrected',
      });
    const compiled = await this.runtime.compiledOf(tx, row.questionnaireVersionId);
    const s = createInterview(compiled, {
      ...this.runtime.engineOptions(row),
      state: row.state as never,
    });
    s.drainEvents();
    if (!s.pathKeys().includes(body.variable))
      throw new BadRequestException({
        code: 'NOT_ON_PATH',
        message: 'This question is not on the interview’s path',
      });
    const r = s.setAnswer(body.variable, body.value as never, 'reviewer');
    if (!r.ok) throw new BadRequestException({ code: 'BAD_VALUE', message: r.error });
    const errors = s.validate(body.variable).errors;
    if (errors.length)
      throw new BadRequestException({
        code: 'INVALID_ANSWER',
        message: errors.map((e) => e.message).join(' '),
        errors,
      });
    // Walk on from the corrected question: the rest of the path must still be answered.
    for (let i = 0; i < 100_000 && s.status().state === 'in_progress'; i++) if (!s.next().ok) break;
    if (s.status().state === 'in_progress')
      throw new ConflictException({
        code: 'PATH_INCOMPLETE',
        message: 'This change opens questions that have no answer; return the interview instead',
        opened: s.currentKey(),
      });
    const events = s.drainEvents();
    let seq = await this.nextReviewSeq(tx, id);
    const now = new Date();
    if (events.length)
      await tx.insert(interviewAnswerEvents).values(
        events.map((e) => ({
          tenantId: ctx.tenantId,
          interviewId: id,
          deviceId: REVIEW_DEVICE,
          seq: seq++,
          variable: e.key,
          oldValue: e.oldValue ?? null,
          newValue: e.newValue ?? null,
          at: now,
          byUserId: ctx.userId,
          source: 'reviewer',
          reason: e.key === body.variable ? 'correction' : (e.reason ?? null),
        })),
      );
    const disposition = s.status().disposition ?? row.disposition;
    await tx
      .update(interviews)
      .set({
        state: s.state(),
        answers: keepCodes(row.answers as Record<string, unknown>, s.getAnswers()),
        // A device holding a copy of this interview (returned later) takes the new state.
        stateVersion: row.stateVersion + 1,
        stateDevice: REVIEW_DEVICE,
        disposition,
        updatedAt: now,
      })
      .where(eq(interviews.id, id));
    await tx.insert(reviewComments).values({
      tenantId: ctx.tenantId,
      interviewId: id,
      variable: body.variable,
      body: body.reason,
      authorId: ctx.userId,
    });
    if (row.caseId && disposition !== row.disposition)
      await tx.update(cases).set({ disposition, updatedAt: now }).where(eq(cases.id, row.caseId));
    await this.audit.record(
      tx,
      ctx.tenantId,
      this.audit.fromContext(ctx, {
        action: 'interview.corrected',
        targetType: 'interview',
        targetId: id,
        details: { variable: body.variable, reason: body.reason, cleared: r.cleared.length },
      }),
    );
    return {
      cleared: r.cleared.map((c) => c.key),
      restored: r.restored.map((c) => c.key),
      disposition,
    };
  }

  /** The caller's interviews returned for fixing, with the latest comment. */
  async returned(tx: Tx, ctx: AuthContext, projectId: string) {
    return tx
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
          eq(interviews.interviewerId, ctx.userId),
          eq(interviews.status, 'returned'),
        ),
      )
      .orderBy(desc(interviews.reviewedAt));
  }

  // -------------------------------------------------------------------------
  // Coding of "other" texts (R6)
  // -------------------------------------------------------------------------

  private async otherTexts(tx: Tx, projectId: string, variable?: string) {
    const rows = (await tx.execute(sql`
      select a.key as key, a.value as value, i.id as interview_id
      from interviews i, jsonb_each_text(i.answers) a
      where i.project_id = ${projectId}
        and i.status in ${COUNTED_SQL}
        and a.key ~ '_OTHER$' and length(trim(a.value)) > 0`)) as unknown as {
      key: string;
      value: string;
      interview_id: string;
    }[];
    return rows.filter((r) => !variable || baseName(r.key) === variable);
  }

  /** Variables with "other" texts, and how many are still without a code. */
  async codingOverview(tx: Tx, projectId: string) {
    const texts = await this.otherTexts(tx, projectId);
    const coded = await tx
      .select({ variable: codedTexts.variable, text: codedTexts.text })
      .from(codedTexts)
      .where(eq(codedTexts.projectId, projectId));
    const done = new Set(coded.map((c) => `${c.variable}\u0000${c.text}`));
    const by = new Map<string, { total: number; uncoded: number }>();
    for (const t of texts) {
      const v = baseName(t.key);
      const e = by.get(v) ?? { total: 0, uncoded: 0 };
      e.total++;
      if (!done.has(`${v}\u0000${norm(t.value)}`)) e.uncoded++;
      by.set(v, e);
    }
    return [...by]
      .map(([variable, n]) => ({ variable, ...n }))
      .sort((a, b) => a.variable.localeCompare(b.variable));
  }

  async codingDetail(tx: Tx, projectId: string, variable: string) {
    const texts = await this.otherTexts(tx, projectId, variable);
    const codes = await tx
      .select({ code: openCodes.code, label: openCodes.label })
      .from(openCodes)
      .where(and(eq(openCodes.projectId, projectId), eq(openCodes.variable, variable)))
      .orderBy(asc(openCodes.code));
    const coded = new Map(
      (
        await tx
          .select({ text: codedTexts.text, code: codedTexts.code })
          .from(codedTexts)
          .where(and(eq(codedTexts.projectId, projectId), eq(codedTexts.variable, variable)))
      ).map((c) => [c.text, c.code]),
    );
    const grouped = new Map<string, { text: string; count: number }>();
    for (const t of texts) {
      const k = norm(t.value);
      const g = grouped.get(k) ?? { text: t.value.trim(), count: 0 };
      g.count++;
      grouped.set(k, g);
    }
    return {
      variable,
      codes,
      texts: [...grouped]
        .map(([k, g]) => ({ ...g, key: k, code: coded.get(k) ?? null }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
    };
  }

  async saveCodes(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    variable: string,
    body: z.infer<typeof CodesBody>,
  ) {
    const keep = body.codes.map((c) => c.code);
    const used = await tx
      .select({ code: codedTexts.code })
      .from(codedTexts)
      .where(and(eq(codedTexts.projectId, projectId), eq(codedTexts.variable, variable)));
    const missing = used.filter((u) => !keep.includes(u.code));
    if (missing.length)
      throw new ConflictException({
        code: 'CODE_IN_USE',
        message: `Codes in use cannot be removed: ${[...new Set(missing.map((m) => m.code))].join(', ')}`,
      });
    await tx
      .delete(openCodes)
      .where(and(eq(openCodes.projectId, projectId), eq(openCodes.variable, variable)));
    if (body.codes.length)
      await tx
        .insert(openCodes)
        .values(body.codes.map((c) => ({ tenantId: ctx.tenantId, projectId, variable, ...c })));
    return this.codingDetail(tx, projectId, variable);
  }

  /**
   * Gives texts a code (or removes it): the code is stored per distinct text and written to
   * every interview with that text as `<VARIABLE>_CODE`, recorded as a reviewer's change.
   */
  async assign(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    variable: string,
    body: z.infer<typeof AssignBody>,
  ) {
    if (body.code !== null) {
      const [ok] = await tx
        .select({ id: openCodes.id })
        .from(openCodes)
        .where(
          and(
            eq(openCodes.projectId, projectId),
            eq(openCodes.variable, variable),
            eq(openCodes.code, body.code),
          ),
        );
      if (!ok) throw new BadRequestException({ code: 'UNKNOWN_CODE', message: 'Unknown code' });
    }
    const keys = [...new Set(body.texts.map(norm))];
    if (body.code === null)
      await tx
        .delete(codedTexts)
        .where(
          and(
            eq(codedTexts.projectId, projectId),
            eq(codedTexts.variable, variable),
            inArray(codedTexts.text, keys),
          ),
        );
    else
      for (const text of keys)
        await tx
          .insert(codedTexts)
          .values({
            tenantId: ctx.tenantId,
            projectId,
            variable,
            text,
            code: body.code,
            codedBy: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [codedTexts.projectId, codedTexts.variable, codedTexts.text],
            set: { code: body.code, codedBy: ctx.userId, codedAt: new Date() },
          });
    const hits = (await this.otherTexts(tx, projectId, variable)).filter((t) =>
      keys.includes(norm(t.value)),
    );
    const now = new Date();
    let changed = 0;
    for (const h of hits) {
      const codeKey = h.key.replace(/_OTHER$/, '_CODE');
      const [iv] = await tx
        .select({ answers: interviews.answers })
        .from(interviews)
        .where(eq(interviews.id, h.interview_id))
        .for('update');
      const old = (iv!.answers as Record<string, unknown>)[codeKey] ?? null;
      if (old === body.code) continue;
      const answers = { ...(iv!.answers as Record<string, unknown>) };
      if (body.code === null) delete answers[codeKey];
      else answers[codeKey] = body.code;
      await tx
        .update(interviews)
        .set({ answers, updatedAt: now })
        .where(eq(interviews.id, h.interview_id));
      await tx.insert(interviewAnswerEvents).values({
        tenantId: ctx.tenantId,
        interviewId: h.interview_id,
        deviceId: REVIEW_DEVICE,
        seq: await this.nextReviewSeq(tx, h.interview_id),
        variable: codeKey,
        oldValue: old,
        newValue: body.code,
        at: now,
        byUserId: ctx.userId,
        source: 'reviewer',
        reason: 'coding',
      });
      changed++;
    }
    return { ...(await this.codingDetail(tx, projectId, variable)), changed };
  }
}
