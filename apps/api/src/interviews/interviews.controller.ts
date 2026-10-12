import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  createInterview,
  verifySubmission,
  type CompiledQuestionnaire,
  type InterviewOptions,
} from '@wansurvey/logic';
import {
  AnswerValueSchema,
  MODES,
  PARADATA_TYPES,
  type ContainerItem,
  type Mode,
} from '@wansurvey/schema';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { MASK, maskContact, maskSample } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
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

const PERM = { projectParam: 'projectId' } as const;
const CONDUCT = 'interviews.conduct';
const MAX_OPS = 2000;

const DeviceId = z.string().min(8).max(100);
const StartBody = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  questionnaireId: z.uuid(),
  mode: z.enum(MODES),
  language: z.string().min(2).max(16).optional(),
  deviceId: DeviceId,
});
const AnswerOp = z.object({
  seq: z.number().int().positive(),
  kind: z.literal('answer'),
  variable: z.string().min(1).max(200),
  oldValue: AnswerValueSchema.nullable().optional(),
  newValue: AnswerValueSchema.nullable().optional(),
  at: z.iso.datetime(),
  source: z.enum(['interviewer', 'respondent', 'reviewer', 'system']),
  reason: z.string().max(40).nullable().optional(),
});
const ParadataOp = z.object({
  seq: z.number().int().positive(),
  kind: z.literal('paradata'),
  type: z.enum(PARADATA_TYPES),
  at: z.iso.datetime(),
  monotonicMs: z.number().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const Op = z.discriminatedUnion('kind', [AnswerOp, ParadataOp]);
const SyncBody = z.object({
  deviceId: DeviceId,
  interviews: z
    .array(
      z.object({
        id: z.uuid(),
        ops: z.array(Op).max(MAX_OPS),
        /** The engine snapshot after the last op in `ops`. */
        state: z.record(z.string(), z.unknown()).optional(),
        position: z.string().max(200).nullable().optional(),
        activeMs: z.number().int().nonnegative().optional(),
        totalMs: z.number().int().nonnegative().optional(),
      }),
    )
    .max(50),
});
const SubmitBody = z.object({
  deviceId: DeviceId,
  /** The client's last change number: everything up to it must be synced. */
  seq: z.number().int().nonnegative(),
  /** The path the client walked, checked against the server's own run. */
  path: z.array(z.string()).max(20_000),
});

type InterviewRow = typeof interviews.$inferSelect;

/**
 * The interview runtime's server side: start or resume an interview on a case, receive its
 * changes in batches (idempotent per device and change number), and accept the submission
 * after re-running the questionnaire logic on the stored answers.
 */
@ApiTags('interviews')
@Controller()
export class InterviewsController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly cases: CasesService,
  ) {}

  /** Starts an interview on a case, or resumes the one in progress. Idempotent on `id`. */
  @Post('projects/:projectId/interviews')
  @HttpCode(200)
  @RequirePermission(CONDUCT, PERM)
  @ApiBody({ schema: z.toJSONSchema(StartBody) as object })
  start(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(StartBody)) body: z.infer<typeof StartBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
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
      // C10: in pool mode, starting on a free case takes it.
      if (!c.assignedTo && settings.assignmentMode === 'pool') {
        await this.cases.claim(tx, ctx, projectId, c.id);
        c.assignedTo = ctx.userId;
      }
      if (c.assignedTo !== ctx.userId) throw new NotFoundException('Case not found');

      const [open] = await tx
        .select()
        .from(interviews)
        .where(and(eq(interviews.caseId, c.id), eq(interviews.status, 'in_progress')));
      let row: InterviewRow;
      if (open) {
        // Resuming: the person holding the case now works it, on this device.
        [row] = (await tx
          .update(interviews)
          .set({ interviewerId: ctx.userId, deviceId: body.deviceId, updatedAt: new Date() })
          .where(eq(interviews.id, open.id))
          .returning()) as [InterviewRow];
      } else {
        const [taken] = await tx.select().from(interviews).where(eq(interviews.id, body.id));
        if (taken)
          throw new ConflictException({ code: 'ID_IN_USE', message: 'Interview id in use' });
        const version = await this.latestVersion(tx, projectId, body.questionnaireId);
        const context = await this.caseContext(
          tx,
          ctx,
          projectId,
          c,
          settings.revealToInterviewers,
        );
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
            details: { interviewId: row.id, mode: body.mode, version: version.version },
          },
        ]);
      }
      await tx
        .insert(interviewDevices)
        .values({
          tenantId: ctx.tenantId,
          interviewId: row.id,
          deviceId: body.deviceId,
        })
        .onConflictDoNothing();
      return this.payload(tx, row, body.deviceId);
    });
  }

  /** Everything a device needs to resume an interview. */
  @Get('interviews/:id')
  @RequirePermission(CONDUCT, { anyProject: true })
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.own(tx, ctx, id);
      return this.payload(tx, row, row.deviceId);
    });
  }

  /**
   * Receives changes in batches. Each change has a number per device; numbers already
   * acknowledged are skipped and nothing after a gap is taken, so sending a batch twice, or
   * out of order, is harmless. The answer is the last number acknowledged per interview.
   */
  @Post('interviews/sync')
  @HttpCode(200)
  @RequirePermission(CONDUCT, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(SyncBody, { io: 'input' }) as object })
  sync(@Auth() ctx: AuthContext, @Body(new ZodPipe(SyncBody)) body: z.infer<typeof SyncBody>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const acks: Record<string, number> = {};
      const errors: Record<string, string> = {};
      for (const item of body.interviews) {
        const [row] = await tx
          .select()
          .from(interviews)
          .where(eq(interviews.id, item.id))
          .for('update');
        if (!row || row.interviewerId !== ctx.userId) {
          errors[item.id] = 'NOT_FOUND';
          continue;
        }
        if (row.deviceId !== body.deviceId) {
          errors[item.id] = 'NOT_THIS_DEVICE';
          continue;
        }
        const [dev] = await tx
          .insert(interviewDevices)
          .values({ tenantId: ctx.tenantId, interviewId: row.id, deviceId: body.deviceId })
          .onConflictDoUpdate({
            target: [interviewDevices.interviewId, interviewDevices.deviceId],
            set: { updatedAt: new Date() },
          })
          .returning({ lastSeq: interviewDevices.lastSeq });
        let last = dev!.lastSeq;
        if (row.status !== 'in_progress') {
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
                tenantId: ctx.tenantId,
                interviewId: row.id,
                deviceId: body.deviceId,
                seq: o.seq,
                variable: o.variable,
                oldValue: o.oldValue ?? null,
                newValue: o.newValue ?? null,
                at: new Date(o.at),
                byUserId: o.source === 'system' ? null : ctx.userId,
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
                tenantId: ctx.tenantId,
                interviewId: row.id,
                deviceId: body.deviceId,
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
            and(
              eq(interviewDevices.interviewId, row.id),
              eq(interviewDevices.deviceId, body.deviceId),
            ),
          );
        acks[item.id] = last;
      }
      return { acks, errors, serverTime: new Date().toISOString() };
    });
  }

  /**
   * Submits a finished interview. The server replays the stored answers with the same
   * questionnaire version and case data; a path that differs from the client's is refused.
   */
  @Post('interviews/:id/submit')
  @HttpCode(200)
  @RequirePermission(CONDUCT, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(SubmitBody) as object })
  submit(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SubmitBody)) body: z.infer<typeof SubmitBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.own(tx, ctx, id, true);
      if (row.status !== 'in_progress')
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
          and(eq(interviewDevices.interviewId, id), eq(interviewDevices.deviceId, body.deviceId)),
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
      const [done] = await tx
        .update(interviews)
        .set({ status: 'submitted', disposition, endedAt: new Date(), updatedAt: new Date() })
        .where(eq(interviews.id, id))
        .returning();
      if (row.caseId) {
        await tx
          .update(cases)
          .set({ status: 'finalised', disposition, updatedAt: new Date() })
          .where(eq(cases.id, row.caseId));
        await this.cases.events(tx, ctx.tenantId, ctx.userId, [
          {
            caseId: row.caseId,
            type: 'interview_submitted',
            details: { interviewId: id, disposition },
          },
        ]);
      }
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'interview.submitted',
          targetType: 'interview',
          targetId: id,
          details: { caseId: row.caseId, disposition },
        }),
      );
      return { status: done!.status, disposition };
    });
  }

  /** A case's interviews with their answer history, oldest change first. */
  @Get('projects/:projectId/cases/:caseId/interviews')
  @RequirePermission(['cases.read_all', 'cases.read_assigned'], PERM)
  history(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [c] = await tx
        .select({ id: cases.id, assignedTo: cases.assignedTo })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)));
      if (!c || (this.cases.restrictedToOwn(ctx, projectId) && c.assignedTo !== ctx.userId))
        throw new NotFoundException('Case not found');
      const rows = await tx
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
      const ids = rows.map((r) => r.id);
      const events = ids.length
        ? await tx
            .select({
              interviewId: interviewAnswerEvents.interviewId,
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
            .where(inArray(interviewAnswerEvents.interviewId, ids))
            .orderBy(asc(interviewAnswerEvents.at), asc(interviewAnswerEvents.seq))
        : [];
      const canSee = this.cases.canSeePii(ctx, projectId);
      return rows.map(({ compiled, ...r }) => {
        // Answers to questions marked personal are masked without `pii.view`.
        const personal = canSee
          ? new Set<string>()
          : personalVariables(compiled as CompiledQuestionnaire);
        const hide = (v: unknown) => (v === null || v === undefined ? v : MASK);
        return {
          ...r,
          events: events
            .filter((e) => e.interviewId === r.id)
            .map(({ interviewId: _i, ...e }) =>
              personal.has(e.variable.replace(/\[.*$/, ''))
                ? { ...e, oldValue: hide(e.oldValue), newValue: hide(e.newValue) }
                : e,
            ),
        };
      });
    });
  }

  // -------------------------------------------------------------------------------------------

  private async own(tx: Tx, ctx: AuthContext, id: string, lock = false) {
    const q = tx.select().from(interviews).where(eq(interviews.id, id));
    const [row] = lock ? await q.for('update') : await q;
    if (!row || row.interviewerId !== ctx.userId || !can(ctx.memberships, CONDUCT, row.projectId))
      throw new NotFoundException('Interview not found');
    return row;
  }

  private async latestVersion(tx: Tx, projectId: string, qid: string) {
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

  private async compiledOf(tx: Tx, versionId: string) {
    const [v] = await tx
      .select({ compiled: questionnaireVersions.compiled })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, versionId));
    return v!.compiled as CompiledQuestionnaire;
  }

  /** Case data for the engine and the screen, masked as the interviewer would see it. */
  private async caseContext(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    c: typeof cases.$inferSelect,
    reveal: boolean,
  ) {
    const show = reveal && this.cases.canSeePii(ctx, projectId);
    const pii = await this.cases.piiFields(tx, projectId);
    const cs = await tx
      .select({ type: contacts.type, value: contacts.value, label: contacts.label })
      .from(contacts)
      .where(eq(contacts.caseId, c.id))
      .orderBy(asc(contacts.createdAt));
    if (show)
      await this.cases.recordAutoViews(
        tx,
        ctx,
        projectId,
        [{ id: c.id, externalId: c.externalId }],
        'detail',
      );
    return {
      externalId: c.externalId,
      case: maskSample(c.sample as Record<string, unknown>, pii, show),
      contacts: cs.map((x) => maskContact(x, show)),
    };
  }

  private engineOptions(row: InterviewRow): Omit<InterviewOptions, 'state'> {
    const context = row.context as { case?: Record<string, unknown> };
    return {
      mode: row.mode as Mode,
      language: row.language,
      seed: row.id,
      now: () => row.startedAt,
      context: { case: context.case ?? {} },
    };
  }

  private async payload(tx: Tx, row: InterviewRow, deviceId: string) {
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
        interviewer: who?.name ?? null,
      },
      context: row.context,
      compiled: v!.compiled,
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
