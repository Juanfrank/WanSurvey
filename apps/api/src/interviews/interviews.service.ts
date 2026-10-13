import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  createInterview,
  respondentFromCase,
  verifySubmission,
  type CompiledQuestionnaire,
  type InterviewOptions,
} from '@wansurvey/logic';
import type { ContainerItem, Mode } from '@wansurvey/schema';
import { and, asc, desc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { maskContact, maskSample } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import {
  cases,
  contacts,
  interviewAnswerEvents,
  interviewDevices,
  interviewParadata,
  interviews,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import type { StartBody, SubmitBody, SyncItem } from './schemas.js';

export type InterviewRow = typeof interviews.$inferSelect;

/** Statuses in which the interviewer can still change answers: open, or returned by review. */
export const EDITABLE = new Set(['in_progress', 'returned']);

/** Who writes: a signed-in person, or a respondent through a link (no user). */
export interface Writer {
  tenantId: string;
  userId: string | null;
  ctx: AuthContext | null;
}

/** Runs inside the submitting transaction, after the interview is marked submitted. */
export type SubmitHook = (
  tx: Tx,
  row: InterviewRow,
  disposition: string,
  writer: Writer,
) => Promise<void>;

/**
 * The interview runtime shared by every mode: start or resume on a case, apply numbered
 * changes from a device, and accept a submission after re-running the logic on the server.
 * CATI, CAPI checkout, CAWI links and PAPI entry build on it.
 */
@Injectable()
export class InterviewsService {
  private readonly hooks: SubmitHook[] = [];

  constructor(
    private readonly audit: AuditService,
    private readonly cases: CasesService,
  ) {}

  /** Set by the CAPI module: creates an interview a device started offline (D2). */
  createOffline?: (
    tx: Tx,
    ctx: AuthContext,
    deviceId: string,
    item: SyncItem,
  ) => Promise<InterviewRow | string>;

  /** Other modules react to submissions (close a call, mark an invitation, compare entries). */
  onSubmitted(hook: SubmitHook) {
    this.hooks.push(hook);
  }

  /**
   * Starts an interview on a case the caller holds (taking it in pool mode), or resumes the
   * one in progress. Idempotent on the client's id.
   */
  async start(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    body: StartBody,
    opts: { entryPass?: number | undefined } = {},
  ): Promise<InterviewRow> {
    const settings = await this.cases.settings(tx, projectId);
    const [c] = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.id, body.caseId), eq(cases.projectId, projectId)))
      .for('update');
    if (!c) throw new NotFoundException('Case not found');
    if (c.status === 'finalised' || c.status === 'withdrawn')
      throw new ConflictException({
        code: 'CASE_CLOSED',
        message: 'This case is finished or withdrawn',
      });
    if (c.checkedOutDevice && c.checkedOutDevice !== body.deviceId)
      throw new ConflictException({
        code: 'CHECKED_OUT_ELSEWHERE',
        message: 'This case is downloaded to another device',
      });
    // C10: in pool mode, starting on a free case takes it.
    if (!c.assignedTo && settings.assignmentMode === 'pool') {
      await this.cases.claim(tx, ctx, projectId, c.id);
      c.assignedTo = ctx.userId;
    }
    const pass = opts.entryPass ?? 1;
    // A second data-entry pass is keyed by another clerk, who does not hold the case.
    if (pass === 1 && c.assignedTo !== ctx.userId) throw new NotFoundException('Case not found');

    const [open] = await tx
      .select()
      .from(interviews)
      .where(and(eq(interviews.caseId, c.id), eq(interviews.status, 'in_progress')));
    let row: InterviewRow;
    if (open) {
      if (open.entryPass !== pass)
        throw new ConflictException({
          code: 'ENTRY_IN_PROGRESS',
          message: 'Another entry of this case is in progress',
        });
      // Resuming: the person holding the case now works it, on this device.
      [row] = (await tx
        .update(interviews)
        .set({ interviewerId: ctx.userId, deviceId: body.deviceId, updatedAt: new Date() })
        .where(eq(interviews.id, open.id))
        .returning()) as [InterviewRow];
    } else {
      const [taken] = await tx.select().from(interviews).where(eq(interviews.id, body.id));
      if (taken) throw new ConflictException({ code: 'ID_IN_USE', message: 'Interview id in use' });
      const version = await this.latestVersion(tx, projectId, body.questionnaireId);
      const context = await this.caseContext(tx, ctx, projectId, c, settings.revealToInterviewers);
      [row] = (await tx
        .insert(interviews)
        .values({
          id: body.id,
          tenantId: ctx.tenantId,
          projectId,
          caseId: c.id,
          questionnaireVersionId: version.id,
          mode: body.mode,
          interviewerId: ctx.userId,
          language:
            body.language ??
            (version.compiled as CompiledQuestionnaire).questionnaire.defaultLanguage,
          context,
          deviceId: body.deviceId,
          entryPass: pass,
        })
        .returning()) as [InterviewRow];
      await tx
        .update(cases)
        .set({ status: 'in_progress', updatedAt: new Date() })
        .where(eq(cases.id, c.id));
      await this.cases.events(tx, ctx.tenantId, ctx.userId, [
        {
          caseId: c.id,
          type: 'interview_started',
          details: { interviewId: row.id, mode: body.mode, version: version.version, pass },
        },
      ]);
    }
    await tx
      .insert(interviewDevices)
      .values({ tenantId: ctx.tenantId, interviewId: row.id, deviceId: body.deviceId })
      .onConflictDoNothing();
    return row;
  }

  /**
   * Applies batches of numbered changes. Numbers already acknowledged are skipped and
   * nothing after a gap is taken, so replays are harmless. `authorize` decides per interview
   * (an error code, or null); `create` makes an interview the server has not seen.
   */
  async sync(
    tx: Tx,
    writer: Writer,
    deviceId: string,
    items: SyncItem[],
    authorize: (row: InterviewRow) => string | null,
    create?: (item: SyncItem) => Promise<InterviewRow | string>,
  ) {
    const acks: Record<string, number> = {};
    const errors: Record<string, string> = {};
    for (const item of items) {
      let [row] = await tx
        .select()
        .from(interviews)
        .where(eq(interviews.id, item.id))
        .for('update');
      if (!row && item.start && create) {
        const made = await create(item);
        if (typeof made === 'string') {
          errors[item.id] = made;
          continue;
        }
        row = made;
      }
      if (!row) {
        errors[item.id] = 'NOT_FOUND';
        continue;
      }
      const refused = authorize(row);
      if (refused) {
        errors[item.id] = refused;
        continue;
      }
      if (row.deviceId !== deviceId) {
        errors[item.id] = 'NOT_THIS_DEVICE';
        continue;
      }
      const [dev] = await tx
        .insert(interviewDevices)
        .values({ tenantId: writer.tenantId, interviewId: row.id, deviceId })
        .onConflictDoUpdate({
          target: [interviewDevices.interviewId, interviewDevices.deviceId],
          set: { updatedAt: new Date() },
        })
        .returning({ lastSeq: interviewDevices.lastSeq });
      let last = dev!.lastSeq;
      if (!EDITABLE.has(row.status)) {
        acks[item.id] = last;
        errors[item.id] = 'SUBMITTED';
        continue;
      }
      // Only the run that continues from the acknowledged number is taken.
      const ops = [...item.ops].filter((o) => o.seq > last).sort((a, b) => a.seq - b.seq);
      const run: typeof ops = [];
      for (const o of ops) {
        if (o.seq !== last + run.length + 1) break;
        run.push(o);
      }
      const answers = run.filter((o) => o.kind === 'answer');
      const para = run.filter((o) => o.kind === 'paradata');
      if (answers.length)
        await tx
          .insert(interviewAnswerEvents)
          .values(
            answers.map((o) => ({
              tenantId: writer.tenantId,
              interviewId: row.id,
              deviceId,
              seq: o.seq,
              variable: o.variable,
              oldValue: o.oldValue ?? null,
              newValue: o.newValue ?? null,
              at: new Date(o.at),
              byUserId: o.source === 'system' ? null : writer.userId,
              source: o.source,
              reason: o.reason ?? null,
            })),
          )
          .onConflictDoNothing();
      if (para.length)
        await tx
          .insert(interviewParadata)
          .values(
            para.map((o) => ({
              tenantId: writer.tenantId,
              interviewId: row.id,
              deviceId,
              seq: o.seq,
              type: o.type,
              at: new Date(o.at),
              monotonicMs: o.monotonicMs ?? null,
              payload: o.payload,
            })),
          )
          .onConflictDoNothing();
      last += run.length;
      // The snapshot belongs to the end of the batch: keep it only when nothing was missed.
      const complete = run.length === ops.length;
      if (complete && (item.state || run.length)) {
        await tx
          .update(interviews)
          .set({
            ...(item.state
              ? {
                  state: item.state,
                  answers: (item.state.answers as Record<string, unknown>) ?? {},
                  position: item.position ?? null,
                }
              : {}),
            ...(item.activeMs !== undefined ? { activeMs: item.activeMs } : {}),
            ...(item.totalMs !== undefined ? { totalMs: item.totalMs } : {}),
            updatedAt: new Date(),
          })
          .where(eq(interviews.id, row.id));
      }
      await tx
        .update(interviewDevices)
        .set({ lastSeq: last, updatedAt: new Date() })
        .where(
          and(eq(interviewDevices.interviewId, row.id), eq(interviewDevices.deviceId, deviceId)),
        );
      acks[item.id] = last;
    }
    return { acks, errors, serverTime: new Date().toISOString() };
  }

  /**
   * Submits a finished interview: everything synced, the server's own run of the stored
   * answers reaches the end on the same path, then the case is finalised and hooks run.
   */
  async submit(tx: Tx, row: InterviewRow, body: SubmitBody, writer: Writer) {
    if (!EDITABLE.has(row.status))
      throw new ConflictException({ code: 'SUBMITTED', message: 'Already submitted' });
    if (row.deviceId !== body.deviceId)
      throw new ConflictException({
        code: 'NOT_THIS_DEVICE',
        message: 'This interview is open on another device',
      });
    const [dev] = await tx
      .select({ lastSeq: interviewDevices.lastSeq })
      .from(interviewDevices)
      .where(
        and(eq(interviewDevices.interviewId, row.id), eq(interviewDevices.deviceId, body.deviceId)),
      );
    if ((dev?.lastSeq ?? 0) < body.seq)
      throw new ConflictException({
        code: 'NOT_SYNCED',
        message: 'Some changes have not reached the server yet',
      });
    const compiled = await this.compiledOf(tx, row.questionnaireVersionId);
    const opts = this.engineOptions(row);
    const state = row.state as InterviewOptions['state'];
    const session = createInterview(compiled, { ...opts, state });
    const status = session.status();
    if (status.state === 'in_progress')
      throw new ConflictException({
        code: 'NOT_COMPLETE',
        message: 'The interview has not reached its end',
      });
    const check = verifySubmission(compiled, opts, session.getAnswers(), body.path);
    if (!check.match)
      throw new UnprocessableEntityException({
        code: 'PATH_MISMATCH',
        message: 'The answers lead to a different path on the server',
        unexpected: check.unexpected.slice(0, 50),
        missing: check.missing.slice(0, 50),
        offPathAnswers: check.offPathAnswers.slice(0, 50),
      });
    const disposition = status.disposition ?? 'COMPLETE';
    const [done] = (await tx
      .update(interviews)
      .set({
        status: 'submitted',
        disposition,
        endedAt: row.endedAt ?? new Date(),
        submittedAt: new Date(),
        submissions: row.submissions + 1,
        updatedAt: new Date(),
      })
      .where(eq(interviews.id, row.id))
      .returning()) as [InterviewRow];
    if (row.caseId) {
      await this.finaliseCase(tx, writer, row.caseId, disposition, {
        interviewId: row.id,
        disposition,
      });
    }
    for (const hook of this.hooks) await hook(tx, done, disposition, writer);
    if (writer.ctx)
      await this.audit.record(
        tx,
        writer.tenantId,
        this.audit.fromContext(writer.ctx, {
          action: 'interview.submitted',
          targetType: 'interview',
          targetId: row.id,
          details: { caseId: row.caseId, disposition },
        }),
      );
    return { status: done.status, disposition };
  }

  /**
   * Marks a case finished with a disposition, unless a hook keeps it open (double entry).
   * Hooks that need the case open set it back; see the PAPI module.
   */
  async finaliseCase(
    tx: Tx,
    writer: Writer,
    caseId: string,
    disposition: string,
    details: Record<string, unknown>,
  ) {
    await tx
      .update(cases)
      .set({ status: 'finalised', disposition, updatedAt: new Date() })
      .where(eq(cases.id, caseId));
    await this.cases.events(tx, writer.tenantId, writer.userId, [
      { caseId, type: 'interview_submitted', details },
    ]);
  }

  async latestVersion(tx: Tx, projectId: string, qid: string) {
    const [v] = await tx
      .select({
        id: questionnaireVersions.id,
        version: questionnaireVersions.version,
        compiled: questionnaireVersions.compiled,
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
    if (!v)
      throw new BadRequestException({
        code: 'NO_PUBLISHED_VERSION',
        message: 'This questionnaire has no version in use',
      });
    return v;
  }

  async compiledOf(tx: Tx, versionId: string) {
    const [v] = await tx
      .select({ compiled: questionnaireVersions.compiled })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    return v!.compiled as CompiledQuestionnaire;
  }

  /** Case data for the engine and the screen, masked as the interviewer would see it. */
  async caseContext(
    tx: Tx,
    ctx: AuthContext | null,
    projectId: string,
    c: typeof cases.$inferSelect,
    reveal: boolean,
  ) {
    const show = !!ctx && reveal && this.cases.canSeePii(ctx, projectId);
    const pii = await this.cases.piiFields(tx, projectId);
    const cs = await tx
      .select({ type: contacts.type, value: contacts.value, label: contacts.label })
      .from(contacts)
      .where(eq(contacts.caseId, c.id))
      .orderBy(asc(contacts.createdAt));
    if (show && ctx)
      await this.cases.recordAutoViews(
        tx,
        ctx,
        projectId,
        [{ id: c.id, externalId: c.externalId }],
        'detail',
      );
    return {
      externalId: c.externalId,
      case: maskSample(this.cases.pii.read(c), pii, show),
      contacts: cs.map((x) => maskContact(x, show)),
    };
  }

  engineOptions(row: InterviewRow): Omit<InterviewOptions, 'state'> {
    const context = row.context as { case?: Record<string, unknown> };
    return {
      mode: row.mode as Mode,
      language: row.language,
      seed: row.id,
      now: () => row.startedAt,
      context: { case: context.case ?? {}, respondent: respondentFromCase(context.case ?? {}) },
    };
  }

  /** Everything a device needs to show and continue an interview. */
  async payload(tx: Tx, row: InterviewRow, deviceId: string) {
    const [dev] = await tx
      .select({ lastSeq: interviewDevices.lastSeq })
      .from(interviewDevices)
      .where(
        and(eq(interviewDevices.interviewId, row.id), eq(interviewDevices.deviceId, deviceId)),
      );
    const [v] = await tx
      .select({
        version: questionnaireVersions.version,
        compiled: questionnaireVersions.compiled,
        questionnaireId: questionnaireVersions.questionnaireId,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, row.questionnaireVersionId));
    const [who] = row.interviewerId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.interviewerId))
      : [];
    return {
      interview: {
        id: row.id,
        projectId: row.projectId,
        caseId: row.caseId,
        questionnaireId: v!.questionnaireId,
        questionnaireVersionId: row.questionnaireVersionId,
        version: v!.version,
        mode: row.mode,
        language: row.language,
        status: row.status,
        disposition: row.disposition,
        startedAt: row.startedAt,
        state: row.state,
        activeMs: row.activeMs,
        totalMs: row.totalMs,
        deviceId: row.deviceId,
        entryPass: row.entryPass,
        interviewer: who?.name ?? null,
      },
      context: row.context,
      compiled: v!.compiled,
      settings: await this.cases
        .settings(tx, row.projectId)
        .then((x) => ({ capi: x.capi, shortcuts: x.shortcuts })),
      lastSeq: dev?.lastSeq ?? 0,
      serverTime: new Date().toISOString(),
    };
  }
}

/** Variables of questions marked personal (masked in histories without `pii.view`). */
export function personalVariables(compiled: CompiledQuestionnaire): Set<string> {
  const out = new Set<string>();
  const walk = (items: ContainerItem[]) => {
    for (const it of items) {
      if (it.kind === 'question' && it.personal) out.add(it.name);
      if ('items' in it && Array.isArray(it.items)) walk(it.items);
    }
  };
  for (const s of compiled.questionnaire.sections) walk(s.items);
  return out;
}
