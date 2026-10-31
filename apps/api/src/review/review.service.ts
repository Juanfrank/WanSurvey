import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { createInterview } from '@wansurvey/logic';
import type { Permission } from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService, type AuditAction } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import { can, type AuthContext } from '../common/auth-context.js';
import { MASK, maskContact, maskSample } from '../cases/case-logic.js';
import type { InterviewRow } from '../interviews/interviews-repo.js';
import { InterviewsService, personalVariables } from '../interviews/interviews.service.js';
import { REVIEW_REPO, type ReviewRepo, type ReviewTx } from './review-repo.js';
import { StatsService } from '../stats/stats.service.js';
import { FLAG_KINDS, computeFlags, inSample } from './flags.js';

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
@Injectable()
export class ReviewService implements OnModuleInit {
  constructor(
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly audit: AuditService,
    private readonly stats: StatsService,
    @Inject(REVIEW_REPO) private readonly repo: ReviewRepo,
  ) {}

  onModuleInit() {
    // The flags are written by the submission's own update.
    this.runtime.onSubmitting((t, row) => this.flags(this.repo.extend(t), row));
  }

  /** Flags and the sample, computed at each submission (R2, R3). */
  private async flags(t: ReviewTx, row: InterviewRow) {
    const settings = (await this.cases.settings(t, row.projectId)).review;
    const compiled = await this.runtime.compiledOf(t, row.questionnaireVersionId);
    const s = createInterview(compiled, {
      ...this.runtime.engineOptions(row),
      state: row.state as never,
    });
    const c = await t.submitCounts(row.id);
    const flags = computeFlags({
      compiled,
      answers: (row.answers ?? {}) as Record<string, unknown>,
      path: s.pathKeys(),
      activeMs: row.activeMs,
      warningsConfirmed: c.warnings,
      doubleEntryDifferences: c.differences,
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
  async queue(t: ReviewTx, projectId: string, q: z.infer<typeof QueueQuery>) {
    const r = await t.queue(projectId, q);
    return { total: r.total, page: q.page, limit: q.limit, rows: r.rows };
  }

  private async load(t: ReviewTx, id: string, lock = false) {
    const row = await t.interview(id, lock);
    if (!row) throw new NotFoundException('Interview not found');
    return row;
  }

  /** Reviewers of the project, or the interviewer whose interview it is. */
  private async access(t: ReviewTx, ctx: AuthContext, id: string, lock = false) {
    const row = await this.load(t, id, lock);
    const reviewer = this.reviewer(ctx, row.projectId);
    if (!reviewer && row.interviewerId !== ctx.userId)
      throw new NotFoundException('Interview not found');
    return { row, reviewer };
  }

  /** Everything the review screen shows (R4). */
  async detail(t: ReviewTx, ctx: AuthContext, id: string) {
    const { row, reviewer } = await this.access(t, ctx, id);
    const compiled = await this.runtime.compiledOf(t, row.questionnaireVersionId);
    const externalId = row.caseId ? await t.externalIdOf(row.caseId) : null;
    const who = row.interviewerId ? await t.userName(row.interviewerId) : null;
    const para = await t.paradataOf(id, [
      'leave_question',
      'note_added',
      'warning_confirmed',
      'paper_meta',
    ]);
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
    const history = (await t.answerEventsOf([id])).map(({ interviewId: _i, seq: _s, ...h }) => h);
    // Without `pii.view`, personal case fields, contacts and answers to personal questions are
    // masked, as in the case's answer history.
    const canSee = this.cases.canSeePii(ctx, row.projectId);
    const personal = canSee ? new Set<string>() : personalVariables(compiled);
    const piiFields = canSee ? new Set<string>() : await this.cases.piiFields(t, row.projectId);
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
        externalId,
        interviewer: who,
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
      comments: await this.comments(t, id),
      allowed,
      canCorrect:
        REVIEWABLE.includes(row.status) &&
        can(ctx.memberships, 'interviews.correct', row.projectId),
      canComment: reviewer || row.status === 'returned',
    };
  }

  async comments(t: ReviewTx, id: string) {
    return t.comments(id);
  }

  async addComment(t: ReviewTx, ctx: AuthContext, id: string, body: z.infer<typeof CommentBody>) {
    const { row, reviewer } = await this.access(t, ctx, id);
    if (!reviewer && row.status !== 'returned')
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Comments are closed' });
    await t.addComment({
      interviewId: id,
      variable: body.variable ?? null,
      body: body.body,
      authorId: ctx.userId,
    });
    return this.comments(t, id);
  }

  async resolveComment(t: ReviewTx, ctx: AuthContext, commentId: string) {
    const c = await t.comment(commentId);
    if (!c) throw new NotFoundException('Comment not found');
    await this.access(t, ctx, c.interviewId);
    await t.setResolved(commentId, c.resolvedAt ? null : new Date());
    return this.comments(t, c.interviewId);
  }

  /**
   * Moves an interview between review statuses (R1). Returning needs a comment and reopens
   * the interview for its interviewer; rejecting keeps it for the audit trail and, by
   * default, sends the case back to be interviewed again.
   */
  async transition(
    t: ReviewTx,
    ctx: AuthContext,
    id: string,
    body: z.infer<typeof TransitionBody>,
  ) {
    const row = await this.load(t, id, true);
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
    await t.setReviewStatus(id, body.to, ctx.userId, now);
    if (body.comment?.trim())
      await t.addComment({
        interviewId: id,
        variable: null,
        body: body.comment.trim(),
        authorId: ctx.userId,
      });
    if (row.caseId) {
      const settings = (await this.cases.settings(t, row.projectId)).review;
      if (body.to === 'returned') await t.caseInProgress(row.caseId, now);
      if (body.to === 'rejected' && settings.rejectReopensCase) await t.reopenCase(row.caseId, now);
      await this.cases.events(t, ctx.userId, [
        {
          caseId: row.caseId,
          type: `interview_${body.to}`,
          details: { interviewId: id, ...(body.comment ? { comment: body.comment } : {}) },
        },
      ]);
    }
    await t.audit(
      this.audit.fromContext(ctx, {
        action: AUDIT[body.to],
        targetType: 'interview',
        targetId: id,
        details: { from: row.status, to: body.to },
      }),
    );
    if (row.submittedAt) await this.stats.touched(t, row.tenantId, row.projectId, row.submittedAt);
    return { status: body.to };
  }

  /**
   * A reviewer's correction (R5): the value goes through the engine like any answer, so
   * validation runs and answers that fall off the path are cleared and recorded. A change
   * that would open questions with no answer is refused (return the interview instead).
   */
  async correct(t: ReviewTx, ctx: AuthContext, id: string, body: z.infer<typeof CorrectBody>) {
    const row = await this.load(t, id, true);
    if (!can(ctx.memberships, 'interviews.correct', row.projectId))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You may not correct answers' });
    if (!REVIEWABLE.includes(row.status))
      throw new ConflictException({
        code: 'NOT_IN_REVIEW',
        message: 'Only submitted interviews or those in review can be corrected',
      });
    const compiled = await this.runtime.compiledOf(t, row.questionnaireVersionId);
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
    let seq = await t.nextReviewSeq(id);
    const now = new Date();
    await t.insertAnswerEvents(
      id,
      REVIEW_DEVICE,
      events.map((e) => ({
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
    await t.saveCorrection(id, {
      state: s.state(),
      answers: keepCodes(row.answers as Record<string, unknown>, s.getAnswers()),
      // A device holding a copy of this interview (returned later) takes the new state.
      stateVersion: row.stateVersion + 1,
      stateDevice: REVIEW_DEVICE,
      disposition,
      now,
    });
    await t.addComment({
      interviewId: id,
      variable: body.variable,
      body: body.reason,
      authorId: ctx.userId,
    });
    if (row.caseId && disposition !== row.disposition)
      await t.setCaseDisposition(row.caseId, disposition, now);
    await t.audit(
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
  async returned(t: ReviewTx, ctx: AuthContext, projectId: string) {
    return t.returnedTo(projectId, ctx.userId);
  }

  // -------------------------------------------------------------------------
  // Coding of "other" texts (R6)
  // -------------------------------------------------------------------------

  /** Variables with "other" texts, and how many are still without a code. */
  async codingOverview(t: ReviewTx, projectId: string) {
    const texts = await t.otherTexts(projectId);
    const coded = await t.codedTexts(projectId);
    const done = new Set(coded.map((c) => `${c.variable}\u0000${c.text}`));
    const by = new Map<string, { total: number; uncoded: number }>();
    for (const x of texts) {
      const v = baseName(x.key);
      const e = by.get(v) ?? { total: 0, uncoded: 0 };
      e.total++;
      if (!done.has(`${v}\u0000${norm(x.value)}`)) e.uncoded++;
      by.set(v, e);
    }
    return [...by]
      .map(([variable, n]) => ({ variable, ...n }))
      .sort((a, b) => a.variable.localeCompare(b.variable));
  }

  async codingDetail(t: ReviewTx, projectId: string, variable: string) {
    const texts = await t.otherTexts(projectId, variable);
    const codes = await t.codesOf(projectId, variable);
    const coded = new Map((await t.codedTexts(projectId, variable)).map((c) => [c.text, c.code]));
    const grouped = new Map<string, { text: string; count: number }>();
    for (const x of texts) {
      const k = norm(x.value);
      const g = grouped.get(k) ?? { text: x.value.trim(), count: 0 };
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
    t: ReviewTx,
    _ctx: AuthContext,
    projectId: string,
    variable: string,
    body: z.infer<typeof CodesBody>,
  ) {
    const { inUse } = await t.saveCodeList(projectId, variable, body.codes);
    if (inUse.length)
      throw new ConflictException({
        code: 'CODE_IN_USE',
        message: `Codes in use cannot be removed: ${inUse.join(', ')}`,
      });
    return this.codingDetail(t, projectId, variable);
  }

  /**
   * Gives texts a code (or removes it): the code is stored per distinct text and written to
   * every interview with that text as `<VARIABLE>_CODE`, recorded as a reviewer's change.
   */
  async assign(
    t: ReviewTx,
    ctx: AuthContext,
    projectId: string,
    variable: string,
    body: z.infer<typeof AssignBody>,
  ) {
    if (body.code !== null && !(await t.codeExists(projectId, variable, body.code)))
      throw new BadRequestException({ code: 'UNKNOWN_CODE', message: 'Unknown code' });
    const keys = [...new Set(body.texts.map(norm))];
    const changed = await t.assignCode({
      projectId,
      variable,
      keys,
      code: body.code,
      userId: ctx.userId,
    });
    return { ...(await this.codingDetail(t, projectId, variable)), changed };
  }
}
