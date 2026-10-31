import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { CompiledQuestionnaire } from '@wansurvey/logic';
import { z } from 'zod';
import { MASK } from '../cases/case-logic.js';
import { CasesService } from '../cases/cases.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import {
  INTERVIEWS_REPO,
  type InterviewRow,
  type InterviewsRepo,
  type InterviewsTx,
} from './interviews-repo.js';
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
    @Inject(INTERVIEWS_REPO) private readonly repo: InterviewsRepo,
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
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
        const open = await t.openInterview(body.caseId);
        // Paper entry has not moved to SQL Server yet.
        entryPass =
          open?.entryPass ?? (await this.papi.nextPass(t.native(), ctx, projectId, body.caseId));
      }
      const row = await this.runtime.start(t, ctx, projectId, body, { entryPass });
      return this.runtime.payload(t, row, body.deviceId);
    });
  }

  /** Everything a device needs to resume an interview. */
  @Get('interviews/:id')
  @RequirePermission(CONDUCT_OR_KEY, { anyProject: true })
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await this.own(t, ctx, id);
      return this.runtime.payload(t, row, row.deviceId);
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
    return this.repo.inTenant(ctx.tenantId, (t) =>
      this.runtime.sync(
        t,
        { tenantId: ctx.tenantId, userId: ctx.userId, ctx },
        body.deviceId,
        body.interviews,
        // As `own`: the caller's interview, in a project where they still conduct or key.
        (row) => (this.mayWrite(ctx, row) ? null : 'NOT_FOUND'),
        this.runtime.createOffline
          ? (item) => this.runtime.createOffline!(t, ctx, body.deviceId, item)
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await this.own(t, ctx, id, true);
      return this.runtime.submit(t, row, body, {
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await this.own(t, ctx, id, true);
      if (!EDITABLE.has(row.status))
        throw new ConflictException({ code: 'SUBMITTED', message: 'Already submitted' });
      const moved = await t.takeOver(id, { deviceId: body.deviceId, now: new Date() });
      await t.ensureDevice(id, body.deviceId);
      return this.runtime.payload(t, moved, body.deviceId);
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const c = await t.caseBrief(projectId, caseId);
      if (!c || (this.cases.restrictedToOwn(ctx, projectId) && c.assignedTo !== ctx.userId))
        throw new NotFoundException('Case not found');
      const rows = await t.caseInterviews(caseId);
      const events = await t.answerEventsOf(rows.map((r) => r.id));
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
            .map(({ interviewId: _i, seq: _s, ...e }) =>
              personal.has(e.variable.replace(/\[.*$/, ''))
                ? { ...e, oldValue: hide(e.oldValue), newValue: hide(e.newValue) }
                : e,
            ),
        };
      });
    });
  }

  // -------------------------------------------------------------------------------------------

  private async own(t: InterviewsTx, ctx: AuthContext, id: string, lock = false) {
    const row = await t.interview(id, lock);
    if (!row || !this.mayWrite(ctx, row)) throw new NotFoundException('Interview not found');
    return row;
  }

  private mayWrite(ctx: AuthContext, row: Pick<InterviewRow, 'interviewerId' | 'projectId'>) {
    return (
      row.interviewerId === ctx.userId &&
      (can(ctx.memberships, CONDUCT, row.projectId) ||
        can(ctx.memberships, 'dataentry.key', row.projectId))
    );
  }
}
