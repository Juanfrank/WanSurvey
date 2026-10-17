import {
  BadRequestException,
  ConflictException,
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
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CasesService, ofQuestionnaire } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import {
  callAttempts,
  cases,
  contacts,
  interviews,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import { InterviewsService, type InterviewRow } from '../interviews/interviews.service.js';
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
  ) {}

  onModuleInit() {
    // Submitting a telephone interview closes its call with the interview's disposition.
    this.runtime.onSubmitted(async (tx, row, disposition) => {
      if (row.mode !== 'CATI' || !row.caseId) return;
      await tx
        .update(callAttempts)
        .set({ disposition, endedAt: new Date() })
        .where(and(eq(callAttempts.interviewId, row.id), isNull(callAttempts.disposition)));
      await tx
        .update(cases)
        .set({
          callLockUserId: null,
          callLockUntil: null,
          nextContactAt: null,
          callbackUserId: null,
        })
        .where(eq(cases.id, row.caseId));
    });
  }

  private async projectTimezone(tx: Tx, projectId: string) {
    return (await this.cases.project(tx, projectId)).timezone;
  }

  /** The caller's call still open in this project: dialling, or answered with its interview. */
  private async openAttempt(tx: Tx, ctx: AuthContext, projectId: string) {
    const [a] = await tx
      .select()
      .from(callAttempts)
      .where(
        and(
          eq(callAttempts.projectId, projectId),
          eq(callAttempts.interviewerId, ctx.userId),
          isNull(callAttempts.endedAt),
          isNull(callAttempts.disposition),
        ),
      )
      .orderBy(desc(callAttempts.startedAt))
      .limit(1);
    return a ?? null;
  }

  /** The caller's open call in this project, or null. */
  async current(tx: Tx, ctx: AuthContext, projectId: string) {
    const open = await this.openAttempt(tx, ctx, projectId);
    if (!open) return null;
    const [c] = await tx.select().from(cases).where(eq(cases.id, open.caseId));
    return this.serve(tx, ctx, projectId, c!, open);
  }

  /**
   * Serves the next case to call: the caller's open call if there is one, otherwise the best
   * eligible case (K1), locked to the caller (K2). Simultaneous requests skip each other's
   * rows, so a case is never served twice.
   */
  async next(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    questionnaireId?: string,
    caseId?: string,
  ) {
    const settings = await this.cases.settings(tx, projectId);
    const tz = await this.projectTimezone(tx, projectId);
    const now = new Date();
    // One request at a time per caller and project, so a caller never holds two open calls.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cati:${projectId}:${ctx.userId}`}))`,
    );
    const open = await this.openAttempt(tx, ctx, projectId);
    if (open) {
      if (caseId && caseId !== open.caseId)
        throw new ConflictException({
          code: 'CALL_OPEN',
          message: 'Finish the open call before calling another case',
        });
      const [c] = await tx.select().from(cases).where(eq(cases.id, open.caseId));
      return this.serve(tx, ctx, projectId, c!, open, questionnaireId);
    }
    const pool = settings.assignmentMode === 'pool';
    if (caseId) {
      const c = await this.callable(tx, projectId, caseId, true);
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
      return this.open(tx, ctx, projectId, c, now, questionnaireId);
    }
    const rows = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          // The cases of the questionnaire being called (each has its own list).
          ofQuestionnaire(questionnaireId),
          inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
          or(isNull(cases.modePreference), eq(cases.modePreference, 'CATI')),
          pool
            ? or(eq(cases.assignedTo, ctx.userId), isNull(cases.assignedTo))
            : eq(cases.assignedTo, ctx.userId),
          or(
            isNull(cases.callLockUntil),
            sql`${cases.callLockUntil} < now()`,
            eq(cases.callLockUserId, ctx.userId),
          ),
          or(isNull(cases.nextContactAt), sql`${cases.nextContactAt} <= now()`),
          or(
            sql`${cases.attempts} < ${settings.cati.maxAttempts}`,
            eq(cases.disposition, 'CALLBACK'),
          ),
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
        sql`(${cases.callbackUserId} = ${ctx.userId}) desc nulls last`,
        sql`(${cases.attempts} = 0) desc`,
        desc(cases.priority),
        sql`${cases.lastAttemptAt} asc nulls first`,
      )
      .limit(CANDIDATES);
    const options = { me: ctx.userId, now, settings: settings.cati, pool, projectTimezone: tz };
    // Only the chosen case is locked; a case another caller is taking is skipped for the next.
    let c: typeof cases.$inferSelect | undefined;
    for (const q of eligibleInOrder(
      rows.map((r) => this.queueCase(r)),
      options,
    )) {
      const [row] = await tx
        .select()
        .from(cases)
        .where(eq(cases.id, q.id))
        .for('update', { skipLocked: true });
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
        ...(await this.upcoming(tx, ctx, projectId)),
      };
    }
    return this.open(tx, ctx, projectId, c, now, questionnaireId);
  }

  /** Locks the case to the caller and opens a call on it. */
  private async open(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    c: typeof cases.$inferSelect,
    now: Date,
    questionnaireId?: string,
  ) {
    await tx
      .update(cases)
      .set({ callLockUserId: ctx.userId, callLockUntil: new Date(now.getTime() + CALL_LOCK_MS) })
      .where(eq(cases.id, c.id));
    const [attempt] = await tx
      .insert(callAttempts)
      .values({
        tenantId: ctx.tenantId,
        projectId,
        caseId: c.id,
        interviewerId: ctx.userId,
      })
      .returning();
    return this.serve(tx, ctx, projectId, c, attempt!, questionnaireId);
  }

  /**
   * A case of the project that can be called by phone at all: open, not on a device, not being
   * interviewed in another mode, with a valid number. Locked for update when asked.
   */
  private async callable(tx: Tx, projectId: string, caseId: string, lock: boolean) {
    const q = tx
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
    if (!c) throw new NotFoundException('Case not found or not callable by phone');
    return c;
  }

  /** A callback may be called before its time when the caller chooses to (still in calling hours). */
  private earlyAllowed(q: QueueCase, now: Date): QueueCase {
    return q.nextContactAt && q.nextContactAt > now ? { ...q, nextContactAt: now } : q;
  }

  private queueCase(r: typeof cases.$inferSelect): QueueCase {
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

  /** When nothing is eligible: the caller's next callback, so the screen can say when. */
  private async upcoming(tx: Tx, ctx: AuthContext, projectId: string) {
    const [n] = await tx
      .select({ at: cases.nextContactAt })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          gt(cases.nextContactAt, new Date()),
          or(eq(cases.callbackUserId, ctx.userId), eq(cases.assignedTo, ctx.userId)),
          inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
        ),
      )
      .orderBy(asc(cases.nextContactAt))
      .limit(1);
    return { nextAt: n?.at ?? null };
  }

  /** Questionnaires with a version in use, by name. */
  async usable(tx: Tx, projectId: string) {
    return tx
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

  /** What the caller sees for a case: data, phones (K5), past calls and scripts. */
  private async serve(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    c: typeof cases.$inferSelect,
    attempt: typeof callAttempts.$inferSelect,
    questionnaireId?: string,
  ) {
    const settings = await this.cases.settings(tx, projectId);
    const tz = caseTimezone(
      (c.sample as Record<string, unknown>).timezone,
      await this.projectTimezone(tx, projectId),
    );
    const context = await this.runtime.caseContext(
      tx,
      ctx,
      projectId,
      c,
      settings.revealToInterviewers,
    );
    // The caller needs the numbers to dial; showing them is recorded once per case (K5).
    const phones = await tx
      .select({ id: contacts.id, value: contacts.value, label: contacts.label })
      .from(contacts)
      .where(and(eq(contacts.caseId, c.id), eq(contacts.type, 'phone'), eq(contacts.valid, true)))
      .orderBy(asc(contacts.createdAt));
    await this.cases.recordAutoViews(
      tx,
      ctx,
      projectId,
      [{ id: c.id, externalId: c.externalId }],
      'detail',
    );
    const history = await this.history(tx, c.id);
    const qs = await this.usable(tx, projectId);
    // A case belongs to one questionnaire; the one asked for only counts for cases without.
    const qid =
      qs.find((q) => q.id === c.questionnaireId)?.id ??
      qs.find((q) => q.id === questionnaireId)?.id ??
      qs[0]?.id ??
      null;
    let openInterview: InterviewRow | undefined;
    if (attempt.interviewId)
      [openInterview] = await tx
        .select()
        .from(interviews)
        .where(eq(interviews.id, attempt.interviewId));
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
      scripts: qid ? await this.scripts(tx, ctx, projectId, qid, context.case) : null,
    };
  }

  /** The case's calls, newest first, numbers shown by their last digits only (K6). */
  async history(tx: Tx, caseId: string) {
    return tx
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

  /** The questionnaire's telephone scripts, piped with the case data, in its main language. */
  private async scripts(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    questionnaireId: string,
    sample: Record<string, unknown>,
  ) {
    const v = await this.runtime.latestVersion(tx, projectId, questionnaireId, undefined, {
      readOnly: true,
    });
    const compiled = v.compiled as CompiledQuestionnaire;
    const s = createInterview(compiled, {
      mode: 'CATI',
      language: compiled.questionnaire.defaultLanguage,
      seed: questionnaireId,
      now: () => new Date(),
      context: { case: sample, ...(await this.people(tx, ctx, sample)) },
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
  private async people(tx: Tx, ctx: AuthContext, sample: Record<string, unknown>) {
    const [me] = await tx
      .select({ name: users.name, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, ctx.userId));
    return {
      respondent: respondentFromCase(sample),
      interviewer: { firstName: me?.firstName ?? me?.name ?? '', name: me?.name ?? '' },
    };
  }

  private async ownAttempt(tx: Tx, ctx: AuthContext, id: string) {
    const [a] = await tx.select().from(callAttempts).where(eq(callAttempts.id, id)).for('update');
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
  async outcome(tx: Tx, ctx: AuthContext, attemptId: string, body: OutcomeBody) {
    const a = await this.ownAttempt(tx, ctx, attemptId);
    const [c] = await tx.select().from(cases).where(eq(cases.id, a.caseId)).for('update');
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
    const settings = await this.cases.settings(tx, a.projectId);
    const interrupted = a.outcome === 'answered';
    if (interrupted && !['callback', 'appointment', 'refusal'].includes(body.outcome))
      throw new BadRequestException({
        code: 'CALL_ANSWERED',
        message: 'An answered call can only end as a callback or a refusal',
      });

    let contact: { id: string; value: string } | undefined;
    if (body.contactId) {
      [contact] = await tx
        .select({ id: contacts.id, value: contacts.value })
        .from(contacts)
        .where(and(eq(contacts.id, body.contactId), eq(contacts.caseId, c.id)));
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
      const row = await this.runtime.start(tx, ctx, a.projectId, {
        id: body.interview.id,
        caseId: c.id,
        questionnaireId: body.interview.questionnaireId,
        mode: 'CATI',
        deviceId: body.interview.deviceId,
        ...(body.interview.language ? { language: body.interview.language } : {}),
      });
      await tx
        .update(callAttempts)
        .set({ ...common, outcome: 'answered', interviewId: row.id })
        .where(eq(callAttempts.id, a.id));
      await tx
        .update(cases)
        .set({
          ...counted,
          callLockUserId: ctx.userId,
          callLockUntil: new Date(now.getTime() + INTERVIEW_LOCK_MS),
          updatedAt: now,
        })
        .where(eq(cases.id, c.id));
      await this.event(tx, ctx, c.id, a.id, 'answered', null);
      return { outcome: 'answered', interview: await this.runtime.payload(tx, row, row.deviceId) };
    }

    const tz = caseTimezone(
      (c.sample as Record<string, unknown>).timezone,
      await this.projectTimezone(tx, a.projectId),
    );
    let disposition: string = OUTCOME_DISPOSITION[body.outcome]!;
    if (interrupted && body.outcome === 'refusal') disposition = 'BREAK_OFF';
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

    await tx
      .update(callAttempts)
      .set({ ...common, outcome: body.outcome, disposition, callbackAt, endedAt: now })
      .where(eq(callAttempts.id, a.id));
    const caseDisposition =
      finalCase && !isFinalOutcome(body.outcome) && !interrupted ? 'NON_CONTACT' : disposition;
    await tx
      .update(cases)
      .set({
        ...counted,
        disposition: caseDisposition,
        ...(finalCase ? { status: 'finalised' } : {}),
        nextContactAt: finalCase ? null : nextContactAt,
        callbackUserId: callbackAt && body.callbackFor === 'me' ? ctx.userId : null,
        callLockUserId: null,
        callLockUntil: null,
        updatedAt: now,
      })
      .where(eq(cases.id, c.id));
    if (interrupted && a.interviewId && finalCase)
      await tx
        .update(interviews)
        .set({ status: 'broken_off', disposition, endedAt: now, updatedAt: now })
        .where(and(eq(interviews.id, a.interviewId), eq(interviews.status, 'in_progress')));
    await this.event(tx, ctx, c.id, a.id, body.outcome, caseDisposition, callbackAt);
    return {
      outcome: body.outcome,
      disposition: caseDisposition,
      final: finalCase,
      nextContactAt: finalCase ? null : nextContactAt,
    };
  }

  private async event(
    tx: Tx,
    ctx: AuthContext,
    caseId: string,
    attemptId: string,
    outcome: CallOutcome,
    disposition: string | null,
    callbackAt: Date | null = null,
  ) {
    await this.cases.events(tx, ctx.tenantId, ctx.userId, [
      {
        caseId,
        type: 'call_attempt',
        details: { attemptId, outcome, disposition, ...(callbackAt ? { callbackAt } : {}) },
      },
    ]);
  }

  /** Gives a case back without calling it: the call is closed without counting as an attempt. */
  async release(tx: Tx, ctx: AuthContext, attemptId: string) {
    const a = await this.ownAttempt(tx, ctx, attemptId);
    if (a.outcome === 'answered')
      throw new BadRequestException({
        code: 'CALL_ANSWERED',
        message: 'An answered call can only end as a callback or a refusal',
      });
    await tx.update(callAttempts).set({ endedAt: new Date() }).where(eq(callAttempts.id, a.id));
    await tx
      .update(cases)
      .set({ callLockUserId: null, callLockUntil: null })
      .where(and(eq(cases.id, a.caseId), eq(cases.callLockUserId, ctx.userId)));
    return { released: true };
  }

  /**
   * Callbacks and appointments for the caller (theirs, or open to anyone on cases they may
   * call), soonest first, with whether each can be called now and, if not, why; and who booked
   * it, with their note. No phone numbers: those come with the call, where showing them is
   * recorded.
   */
  async callbacks(tx: Tx, ctx: AuthContext, projectId: string) {
    const settings = await this.cases.settings(tx, projectId);
    const tz = await this.projectTimezone(tx, projectId);
    const pool = settings.assignmentMode === 'pool';
    const now = new Date();
    const forUser = sql<
      string | null
    >`(select u.name from users u where u.id = cases.callback_user_id)`;
    const booking = sql<{ outcome: string; note: string | null; by: string | null } | null>`(
      select json_build_object('outcome', a.outcome, 'note', a.note, 'by', u.name)
        from call_attempts a left join users u on u.id = a.interviewer_id
       where a.case_id = cases.id and a.callback_at is not null
       order by a.ended_at desc nulls last limit 1)`;
    const rows = await tx
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
            eq(cases.callbackUserId, ctx.userId),
            and(
              isNull(cases.callbackUserId),
              pool
                ? or(eq(cases.assignedTo, ctx.userId), isNull(cases.assignedTo))
                : eq(cases.assignedTo, ctx.userId),
            ),
          ),
        ),
      )
      .orderBy(asc(cases.nextContactAt))
      .limit(200);
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
