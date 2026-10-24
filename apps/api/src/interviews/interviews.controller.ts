import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { MASK } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
import {
  cases,
  interviewAnswerEvents,
  interviewDevices,
  interviews,
  questionnaireVersions,
  users,
} from '../db/schema.js';
import { DeviceId, StartBody, SubmitBody, SyncBody } from './schemas.js';

const TakeoverBody = z.object({ deviceId: DeviceId });
import { PapiService } from '../papi/papi.service.js';
import { EDITABLE, InterviewsService, personalVariables } from './interviews.service.js';

export { personalVariables };

const PERM = { projectParam: 'projectId' } as const;
const CONDUCT = 'interviews.conduct';
/** PAPI data entry is done by clerks, who key paper forms rather than conduct interviews. */
const CONDUCT_OR_KEY = ['interviews.conduct', 'dataentry.key'] as const;

/**
 * The interview runtime for staff: start or resume an interview on a case, send changes in
 * batches, submit, and read a case's answer history. The logic is in `InterviewsService`.
 */
@ApiTags('interviews')
@Controller()
export class InterviewsController {
  constructor(
    private readonly database: Database,
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly papi: PapiService,
  ) {}

  /** Starts an interview on a case, or resumes the one in progress. Idempotent on `id`. */
  @Post('projects/:projectId/interviews')
  @HttpCode(200)
  @RequirePermission(CONDUCT_OR_KEY, PERM)
  @ApiBody({ schema: z.toJSONSchema(StartBody) as object })
  start(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(StartBody)) body: StartBody,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      // Clerks only key paper forms; interviewers conduct the other modes.
      const allowed =
        body.mode === 'PAPI'
          ? can(ctx.memberships, 'dataentry.key', projectId) ||
            can(ctx.memberships, CONDUCT, projectId)
          : can(ctx.memberships, CONDUCT, projectId);
      if (!allowed) throw new NotFoundException('Case not found');
      // Paper forms: the entry in progress continues, otherwise the next one (P3).
      let entryPass: number | undefined;
      if (body.mode === 'PAPI') {
        const [open] = await tx
          .select({ pass: interviews.entryPass })
          .from(interviews)
          .where(and(eq(interviews.caseId, body.caseId), eq(interviews.status, 'in_progress')));
        entryPass = open?.pass ?? (await this.papi.nextPass(tx, ctx, projectId, body.caseId));
      }
      const row = await this.runtime.start(tx, ctx, projectId, body, { entryPass });
      return this.runtime.payload(tx, row, body.deviceId);
    });
  }

  /** Everything a device needs to resume an interview. */
  @Get('interviews/:id')
  @RequirePermission(CONDUCT_OR_KEY, { anyProject: true })
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.own(tx, ctx, id);
      return this.runtime.payload(tx, row, row.deviceId);
    });
  }

  /**
   * Receives changes in batches. Each change has a number per device; numbers already
   * acknowledged are skipped and nothing after a gap is taken, so sending a batch twice, or
   * out of order, is harmless. The answer is the last number acknowledged per interview.
   */
  @Post('interviews/sync')
  @HttpCode(200)
  @RequirePermission(CONDUCT_OR_KEY, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(SyncBody, { io: 'input' }) as object })
  sync(@Auth() ctx: AuthContext, @Body(new ZodPipe(SyncBody)) body: z.infer<typeof SyncBody>) {
    return this.database.withTenant(ctx.tenantId, (tx) =>
      this.runtime.sync(
        tx,
        { tenantId: ctx.tenantId, userId: ctx.userId, ctx },
        body.deviceId,
        body.interviews,
        // As `own`: the caller's interview, in a project where they still conduct or key.
        (row) => (this.mayWrite(ctx, row) ? null : 'NOT_FOUND'),
        this.runtime.createOffline
          ? (item) => this.runtime.createOffline!(tx, ctx, body.deviceId, item)
          : undefined,
      ),
    );
  }

  /**
   * Submits a finished interview. The server replays the stored answers with the same
   * questionnaire version and case data; a path that differs from the client's is refused.
   */
  @Post('interviews/:id/submit')
  @HttpCode(200)
  @RequirePermission(CONDUCT_OR_KEY, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(SubmitBody) as object })
  submit(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SubmitBody)) body: SubmitBody,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.own(tx, ctx, id, true);
      return this.runtime.submit(tx, row, body, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        ctx,
      });
    });
  }

  /**
   * Continues one of the caller's interviews on this device (a returned interview, or one
   * open elsewhere): the device takes it over and the other one's unsent changes are refused.
   */
  @Post('interviews/:id/takeover')
  @HttpCode(200)
  @RequirePermission(CONDUCT_OR_KEY, { anyProject: true })
  @ApiBody({ schema: z.toJSONSchema(TakeoverBody) as object })
  takeover(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TakeoverBody)) body: z.infer<typeof TakeoverBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.own(tx, ctx, id, true);
      if (!EDITABLE.has(row.status))
        throw new ConflictException({ code: 'SUBMITTED', message: 'Already submitted' });
      const [moved] = await tx
        .update(interviews)
        .set({ deviceId: body.deviceId, updatedAt: new Date() })
        .where(eq(interviews.id, id))
        .returning();
      await tx
        .insert(interviewDevices)
        .values({ tenantId: ctx.tenantId, interviewId: id, deviceId: body.deviceId })
        .onConflictDoNothing();
      return this.runtime.payload(tx, moved!, body.deviceId);
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
    if (!row || !this.mayWrite(ctx, row)) throw new NotFoundException('Interview not found');
    return row;
  }

  private mayWrite(ctx: AuthContext, row: { interviewerId: string | null; projectId: string }) {
    return (
      row.interviewerId === ctx.userId &&
      (can(ctx.memberships, CONDUCT, row.projectId) ||
        can(ctx.memberships, 'dataentry.key', row.projectId))
    );
  }
}
