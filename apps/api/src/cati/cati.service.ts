import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { createInterview, respondentFromCase, type CompiledQuestionnaire } from '@wansurvey/logic';
import {
  CALL_OUTCOMES,
  OUTCOME_DISPOSITION,
  isFinalOutcome,
  needsCallbackTime,
  withinHours,
  type CallOutcome,
  type CatiSettings,
} from '@wansurvey/schema';
import { z } from 'zod';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import type { CaseFull, InterviewRow } from '../interviews/interviews-repo.js';
import { InterviewsService } from '../interviews/interviews.service.js';
import { CATI_REPO, type AttemptRow, type CatiRepo, type CatiTx } from './cati-repo.js';
import { DeviceId } from '../interviews/schemas.js';
import {
  caseTimezone,
  eligibleInOrder,
  ineligible,
  nextEligible,
  type QueueCase,
} from './queue.js';

/** How long a case stays with the caller while dialling (K2). */
export const CALL_LOCK_MS = 20 * 60_000;
/** While an answered call's interview runs. */
export const INTERVIEW_LOCK_MS = 4 * 60 * 60_000;
/** Candidates read per request; the best ones by the SQL order come first. */
const CANDIDATES = 200;

export const NextBody = z.strictObject({
  questionnaireId: z.uuid().optional(),
  /** Call this case now (from the caller's callbacks), if the queue rules allow it. */
  caseId: z.uuid().optional(),
});

export const OutcomeBody = z.strictObject({
  outcome: z.enum(CALL_OUTCOMES),
  contactId: z.uuid().optional(),
  /** UTC instant of a callback or appointment. */
  callbackAt: z.iso.datetime({ offset: true }).optional(),
  /** `me`: only the caller gets it; `anyone`: the case holder or, in pool mode, anyone. */
  callbackFor: z.enum(['me', 'anyone']).default('me'),
  note: z.string().max(2000).optional(),
  connectedMs: z.number().int().min(0).max(86_400_000).optional(),
  wrapUpMs: z.number().int().min(0).max(86_400_000).optional(),
  /** Answered: the interview to start (client id, as in `POST …/interviews`). */
  interview: z
    .strictObject({
      id: z.uuid(),
      deviceId: DeviceId,
      questionnaireId: z.uuid(),
      language: z.string().min(2).max(16).optional(),
    })
    .optional(),
});
export type OutcomeBody = z.infer<typeof OutcomeBody>;

const lastDigits = (v: string) => `••${v.replace(/\D/g, '').slice(-4)}`;

/**
 * Telephone interviewing: serves the next case to call, records what happened on each call
 * and schedules retries and callbacks (spec §6.2, decisions K1–K6).
 */
@Injectable()
export class CatiService implements OnModuleInit {
  constructor(
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    @Inject(CATI_REPO) private readonly repo: CatiRepo,
  ) {}

  onModuleInit() {
    // Submitting a telephone interview closes its call with the interview's disposition.
    this.runtime.onSubmitted(async (t, row, disposition) => {
      if (row.mode !== 'CATI' || !row.caseId) return;
      await this.repo.extend(t).closeCallOfInterview(row, disposition);
    });
  }

  private async projectTimezone(t: CatiTx, projectId: string) {
    return (await this.cases.project(t, projectId)).timezone;
  }

  /** The caller's call still open in this project: dialling, or answered with its interview. */
  private openAttempt(t: CatiTx, ctx: AuthContext, projectId: string) {
    return t.openAttempt(projectId, ctx.userId);
  }

  /** The caller's open call in this project, or null. */
  async current(t: CatiTx, ctx: AuthContext, projectId: string) {
    const open = await this.openAttempt(t, ctx, projectId);
    if (!open) return null;
    const c = await t.caseOf(open.caseId);
    return this.serve(t, ctx, projectId, c!, open);
  }

  /**
   * Serves the next case to call: the caller's open call if there is one, otherwise the best
   * eligible case (K1), locked to the caller (K2). Simultaneous requests skip each other's
   * rows, so a case is never served twice.
   */
  async next(
    t: CatiTx,
    ctx: AuthContext,
    projectId: string,
    questionnaireId?: string,
    caseId?: string,
  ) {
    const settings = await this.cases.settings(t, projectId);
    const tz = await this.projectTimezone(t, projectId);
    const now = new Date();
    // One request at a time per caller and project, so a caller never holds two open calls.
    await t.lockQueue(projectId, ctx.userId);
    const open = await this.openAttempt(t, ctx, projectId);
    if (open) {
      if (caseId && caseId !== open.caseId)
        throw new ConflictException({
          code: 'CALL_OPEN',
          message: 'Finish the open call before calling another case',
        });
      const c = await t.caseOf(open.caseId);
      return this.serve(t, ctx, projectId, c!, open, questionnaireId);
    }
    const pool = settings.assignmentMode === 'pool';
    if (caseId) {
      const c = await t.callable(projectId, caseId, true);
      if (!c) throw new NotFoundException('Case not found or not callable by phone');
      const reason = ineligible(this.earlyAllowed(this.queueCase(c), now), {
        me: ctx.userId,
        now,
        settings: settings.cati,
        pool,
        projectTimezone: tz,
      });
      if (reason)
        throw new ConflictException({
          code: 'CANNOT_CALL',
          message: 'This case cannot be called now',
          reason,
        });
      return this.open(t, ctx, projectId, c, now, questionnaireId);
    }
    const rows = await t.candidates({
      projectId,
      questionnaireId,
      userId: ctx.userId,
      pool,
      maxAttempts: settings.cati.maxAttempts,
      limit: CANDIDATES,
    });
    const options = { me: ctx.userId, now, settings: settings.cati, pool, projectTimezone: tz };
    // Only the chosen case is locked; a case another caller is taking is skipped for the next.
    let c: CaseFull | undefined;
    for (const q of eligibleInOrder(
      rows.map((r) => this.queueCase(r)),
      options,
    )) {
      const row = await t.lockSkipping(q.id);
      if (row && !ineligible(this.queueCase(row), options)) {
        c = row;
        break;
      }
    }
    if (!c) {
      const pick = nextEligible(
        rows.map((r) => this.queueCase(r)),
        options,
      );
      return {
        reason: 'reason' in pick ? pick.reason : 'locked',
        nextAt: await t.upcoming(projectId, ctx.userId),
      };
    }
    return this.open(t, ctx, projectId, c, now, questionnaireId);
  }

  /** Locks the case to the caller and opens a call on it. */
  private async open(
    t: CatiTx,
    ctx: AuthContext,
    projectId: string,
    c: CaseFull,
    now: Date,
    questionnaireId?: string,
  ) {
    await t.setCallLock(c.id, ctx.userId, new Date(now.getTime() + CALL_LOCK_MS));
    const attempt = await t.startAttempt({ projectId, caseId: c.id, interviewerId: ctx.userId });
    return this.serve(t, ctx, projectId, c, attempt, questionnaireId);
  }

  /** A callback may be called before its time when the caller chooses to (still in calling hours). */
  private earlyAllowed(q: QueueCase, now: Date): QueueCase {
    return q.nextContactAt && q.nextContactAt > now ? { ...q, nextContactAt: now } : q;
  }

  private queueCase(r: CaseFull): QueueCase {
    return {
      id: r.id,
      priority: r.priority,
      attempts: r.attempts,
      lastAttemptAt: r.lastAttemptAt,
      nextContactAt: r.nextContactAt,
      disposition: r.disposition,
      assignedTo: r.assignedTo,
      callbackUserId: r.callbackUserId,
      callLockUserId: r.callLockUserId,
      callLockUntil: r.callLockUntil,
      timezone: (r.sample as Record<string, unknown>).timezone,
    };
  }

  /** Questionnaires with a version in use, by name. */
  async usable(t: CatiTx, projectId: string) {
    return t.usableQuestionnaires(projectId);
  }

  /** What the caller sees for a case: data, phones (K5), past calls and scripts. */
  private async serve(
    t: CatiTx,
    ctx: AuthContext,
    projectId: string,
    c: CaseFull,
    attempt: AttemptRow,
    questionnaireId?: string,
  ) {
    const settings = await this.cases.settings(t, projectId);
    const tz = caseTimezone(
      (c.sample as Record<string, unknown>).timezone,
      await this.projectTimezone(t, projectId),
    );
    const context = await this.runtime.caseContext(
      t,
      ctx,
      projectId,
      c,
      settings.revealToInterviewers,
    );
    // The caller needs the numbers to dial; showing them is recorded once per case (K5).
    const phones = await t.phones(c.id);
    await this.cases.recordAutoViews(
      t,
      ctx,
      projectId,
      [{ id: c.id, externalId: c.externalId }],
      'detail',
    );
    const history = await this.history(t, c.id);
    const qs = await this.usable(t, projectId);
    // A case belongs to one questionnaire; the one asked for only counts for cases without.
    const qid =
      qs.find((q) => q.id === c.questionnaireId)?.id ??
      qs.find((q) => q.id === questionnaireId)?.id ??
      qs[0]?.id ??
      null;
    let openInterview: InterviewRow | undefined;
    if (attempt.interviewId) openInterview = (await t.interview(attempt.interviewId)) ?? undefined;
    return {
      attempt: {
        id: attempt.id,
        startedAt: attempt.startedAt,
        outcome: attempt.outcome,
        interviewId: openInterview?.status === 'in_progress' ? openInterview.id : null,
      },
      case: {
        id: c.id,
        externalId: c.externalId,
        status: c.status,
        disposition: c.disposition,
        priority: c.priority,
        attempts: c.attempts,
        nextContactAt: c.nextContactAt,
        timezone: tz,
        sample: (context as { case: Record<string, unknown> }).case,
      },
      phones,
      history,
      callingHours: settings.cati.callingHours,
      questionnaires: qs,
      questionnaireId: qid,
      scripts: qid ? await this.scripts(t, ctx, projectId, qid, context.case) : null,
    };
  }

  /** The case's calls, newest first, numbers shown by their last digits only (K6). */
  async history(t: CatiTx, caseId: string) {
    return t.attempts(caseId);
  }

  /** The questionnaire's telephone scripts, piped with the case data, in its main language. */
  private async scripts(
    t: CatiTx,
    ctx: AuthContext,
    projectId: string,
    questionnaireId: string,
    sample: Record<string, unknown>,
  ) {
    const v = await this.runtime.latestVersion(t, projectId, questionnaireId, undefined, {
      readOnly: true,
    });
    const compiled = v.compiled as CompiledQuestionnaire;
    const s = createInterview(compiled, {
      mode: 'CATI',
      language: compiled.questionnaire.defaultLanguage,
      seed: questionnaireId,
      now: () => new Date(),
      context: { case: sample, ...(await this.people(t, ctx, sample)) },
    });
    const outcomes: Record<string, { id: string; text: string }[]> = {};
    for (const o of CALL_OUTCOMES) {
      const found = s.scriptsFor({
        at: 'callOutcome',
        outcome: o === 'appointment' ? 'callback' : o,
      });
      if (found.length) outcomes[o] = found;
    }
    return { intro: s.scriptsFor({ at: 'start' }), outcomes };
  }

  /** `respondent.*` from the case's name fields and `interviewer.*` from the caller, for piping. */
  private async people(t: CatiTx, ctx: AuthContext, sample: Record<string, unknown>) {
    const me = await t.names(ctx.userId);
    return {
      respondent: respondentFromCase(sample),
      interviewer: { firstName: me?.firstName ?? me?.name ?? '', name: me?.name ?? '' },
    };
  }

  private async ownAttempt(t: CatiTx, ctx: AuthContext, id: string) {
    const a = await t.attemptForUpdate(id);
    if (!a || a.interviewerId !== ctx.userId) throw new NotFoundException('Call not found');
    if (a.disposition || (a.endedAt && a.outcome !== 'answered'))
      throw new ConflictException({
        code: 'CALL_CLOSED',
        message: 'This call is already recorded',
      });
    return a;
  }

  /**
   * Records what happened on a call (K4): answered starts or resumes the telephone interview;
   * final outcomes finish the case; temporary ones schedule a retry; callbacks and appointments
   * are booked inside calling hours in the respondent's time zone. An answered call whose
   * interview is still open can be closed as a callback (interrupted) or a refusal (break-off).
   */
  async outcome(t: CatiTx, ctx: AuthContext, attemptId: string, body: OutcomeBody) {
    const a = await this.ownAttempt(t, ctx, attemptId);
    const c = await t.lockCaseById(a.caseId);
    if (!c) throw new NotFoundException('Case not found');
    const now = new Date();
    if (
      c.callLockUserId &&
      c.callLockUserId !== ctx.userId &&
      c.callLockUntil &&
      c.callLockUntil > now
    )
      throw new ConflictException({
        code: 'LOCK_LOST',
        message: 'Someone else is calling this case now',
      });
    const settings = await this.cases.settings(t, a.projectId);
    const interrupted = a.outcome === 'answered';
    if (interrupted && !['callback', 'appointment', 'refusal'].includes(body.outcome))
      throw new BadRequestException({
        code: 'CALL_ANSWERED',
        message: 'An answered call can only end as a callback or a refusal',
      });

    let contact: { id: string; value: string } | null = null;
    if (body.contactId) {
      contact = await t.contactOf(c.id, body.contactId);
      if (!contact)
        throw new BadRequestException({ code: 'BAD_CONTACT', message: 'Unknown number' });
    }
    const common = {
      ...(contact ? { contactId: contact.id, numberMasked: lastDigits(contact.value) } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.connectedMs !== undefined ? { connectedMs: body.connectedMs } : {}),
      ...(body.wrapUpMs !== undefined ? { wrapUpMs: body.wrapUpMs } : {}),
    };
    const counted = interrupted ? {} : { attempts: c.attempts + 1, lastAttemptAt: now };

    if (body.outcome === 'answered') {
      if (!body.interview)
        throw new BadRequestException({
          code: 'INTERVIEW_REQUIRED',
          message: 'Say which questionnaire to start',
        });
      const row = await this.runtime.start(t, ctx, a.projectId, {
        id: body.interview.id,
        caseId: c.id,
        questionnaireId: body.interview.questionnaireId,
        mode: 'CATI',
        deviceId: body.interview.deviceId,
        ...(body.interview.language ? { language: body.interview.language } : {}),
      });
      await t.patchAttempt(a.id, { ...common, outcome: 'answered', interviewId: row.id });
      await t.patchCase(c.id, {
        ...counted,
        callLockUserId: ctx.userId,
        callLockUntil: new Date(now.getTime() + INTERVIEW_LOCK_MS),
        updatedAt: now,
      });
      await this.event(t, ctx, c.id, a.id, 'answered', null);
      return { outcome: 'answered', interview: await this.runtime.payload(t, row, row.deviceId) };
    }

    const tz = caseTimezone(
      (c.sample as Record<string, unknown>).timezone,
      await this.projectTimezone(t, a.projectId),
    );
    let disposition: string = OUTCOME_DISPOSITION[body.outcome]!;
    if (interrupted && body.outcome === 'refusal') disposition = 'BREAK_OFF';
    // The case was finished meanwhile (on the web, say): the call is recorded, and the case
    // keeps its result and books no further call.
    if (c.status === 'finalised' || c.status === 'withdrawn') {
      await t.patchAttempt(a.id, { ...common, outcome: body.outcome, disposition, endedAt: now });
      await t.patchCase(c.id, {
        ...counted,
        callLockUserId: null,
        callLockUntil: null,
        updatedAt: now,
      });
      await this.event(t, ctx, c.id, a.id, body.outcome, c.disposition);
      return {
        outcome: body.outcome,
        disposition: c.disposition,
        final: true,
        nextContactAt: null,
      };
    }
    let callbackAt: Date | null = null;
    let finalCase = isFinalOutcome(body.outcome);
    let nextContactAt: Date | null = null;

    if (needsCallbackTime(body.outcome)) {
      if (!body.callbackAt)
        throw new BadRequestException({
          code: 'CALLBACK_TIME',
          message: 'Choose when to call back',
        });
      callbackAt = new Date(body.callbackAt);
      if (callbackAt.getTime() < now.getTime() - 60_000)
        throw new BadRequestException({
          code: 'CALLBACK_PAST',
          message: 'The callback time has passed',
        });
      if (!withinHours(callbackAt, tz, settings.cati.callingHours))
        throw new BadRequestException({
          code: 'OUTSIDE_CALLING_HOURS',
          message: 'The callback is outside calling hours in the respondent’s time zone',
        });
      nextContactAt = callbackAt;
    } else if (!finalCase) {
      const retry = settings.cati.retryMinutes[body.outcome as keyof CatiSettings['retryMinutes']];
      nextContactAt = new Date(now.getTime() + retry * 60_000);
      // The last allowed attempt without contact ends the case as a non-contact.
      if (c.attempts + 1 >= settings.cati.maxAttempts) finalCase = true;
    }

    await t.patchAttempt(a.id, {
      ...common,
      outcome: body.outcome,
      disposition,
      callbackAt,
      endedAt: now,
    });
    const caseDisposition =
      finalCase && !isFinalOutcome(body.outcome) && !interrupted ? 'NON_CONTACT' : disposition;
    await t.patchCase(c.id, {
      ...counted,
      disposition: caseDisposition,
      ...(finalCase ? { status: 'finalised' } : {}),
      nextContactAt: finalCase ? null : nextContactAt,
      callbackUserId: callbackAt && body.callbackFor === 'me' ? ctx.userId : null,
      callLockUserId: null,
      callLockUntil: null,
      updatedAt: now,
    });
    if (interrupted && a.interviewId && finalCase)
      await t.breakOff(a.interviewId, disposition, now);
    await this.event(t, ctx, c.id, a.id, body.outcome, caseDisposition, callbackAt);
    return {
      outcome: body.outcome,
      disposition: caseDisposition,
      final: finalCase,
      nextContactAt: finalCase ? null : nextContactAt,
    };
  }

  private async event(
    t: CatiTx,
    ctx: AuthContext,
    caseId: string,
    attemptId: string,
    outcome: CallOutcome,
    disposition: string | null,
    callbackAt: Date | null = null,
  ) {
    await this.cases.events(t, ctx.tenantId, ctx.userId, [
      {
        caseId,
        type: 'call_attempt',
        details: { attemptId, outcome, disposition, ...(callbackAt ? { callbackAt } : {}) },
      },
    ]);
  }

  /** Gives a case back without calling it: the call is closed without counting as an attempt. */
  async release(t: CatiTx, ctx: AuthContext, attemptId: string) {
    const a = await this.ownAttempt(t, ctx, attemptId);
    if (a.outcome === 'answered')
      throw new BadRequestException({
        code: 'CALL_ANSWERED',
        message: 'An answered call can only end as a callback or a refusal',
      });
    await t.patchAttempt(a.id, { endedAt: new Date() });
    await t.unlock(a.caseId, ctx.userId);
    return { released: true };
  }

  /**
   * Callbacks and appointments for the caller (theirs, or open to anyone on cases they may
   * call), soonest first, with whether each can be called now and, if not, why; and who booked
   * it, with their note. No phone numbers: those come with the call, where showing them is
   * recorded.
   */
  async callbacks(t: CatiTx, ctx: AuthContext, projectId: string) {
    const settings = await this.cases.settings(t, projectId);
    const tz = await this.projectTimezone(t, projectId);
    const pool = settings.assignmentMode === 'pool';
    const now = new Date();
    const rows = await t.callbacks(projectId, ctx.userId, pool);
    const options = { me: ctx.userId, now, settings: settings.cati, pool, projectTimezone: tz };
    return rows.map(({ c, forUserName, booking: b, phone, otherMode }) => {
      const reason = !phone
        ? 'no_phone'
        : otherMode || c.checkedOutDevice
          ? 'other_mode'
          : ineligible(this.earlyAllowed(this.queueCase(c), now), options);
      return {
        caseId: c.id,
        externalId: c.externalId,
        at: c.nextContactAt,
        due: !!c.nextContactAt && c.nextContactAt <= now,
        mine: c.callbackUserId === ctx.userId,
        forUserName,
        timezone: caseTimezone((c.sample as Record<string, unknown>).timezone, tz),
        kind: b?.outcome === 'appointment' ? 'appointment' : 'callback',
        bookedBy: b?.by ?? null,
        note: b?.note ?? null,
        attempts: c.attempts,
        callableNow: !reason,
        reason,
      };
    });
  }
}
