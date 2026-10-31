import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, can, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CasesService } from '../cases/cases.service.js';
import { METRICS_REPO, type MetricsRepo, type MetricsTx } from './metrics-repo.js';
import { daysBetween, FREQUENCIES, windowOf, windowsIn, type Frequency } from './goal-periods.js';

const PERM = { projectParam: 'projectId' } as const;
const Day = z.iso.date();

export const GoalBody = z
  .object({
    /** Null: the whole team (every interviewer's completes count). */
    userId: z.uuid().nullable(),
    frequency: z.enum(FREQUENCIES).default('period'),
    /** Null: completes of any questionnaire of the project count. */
    questionnaireId: z.uuid().nullable().default(null),
    startsOn: Day,
    endsOn: Day,
    target: z.number().int().min(1).max(1_000_000),
  })
  .refine((g) => g.endsOn >= g.startsOn, { message: 'The period ends before it starts' });
const GoalPatch = z.object({
  frequency: z.enum(FREQUENCIES).optional(),
  startsOn: Day.optional(),
  endsOn: Day.optional(),
  target: z.number().int().min(1).max(1_000_000).optional(),
});

/**
 * Goals per interviewer, or for the whole team, between two dates: completes to reach once for
 * the period or each day, business day, week or month, optionally for one questionnaire.
 * Progress counts complete interviews submitted (in the project's time zone), except rejected
 * ones: in the current window, with the pace due by today, and over the whole period.
 */
@ApiTags('metrics')
@Controller('projects/:projectId/goals')
export class GoalsController {
  constructor(
    @Inject(METRICS_REPO) private readonly repo: MetricsRepo,
    private readonly cases: CasesService,
  ) {}

  @Get()
  @RequirePermission(['metrics.team', 'metrics.own'], PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const team = can(ctx.memberships, 'metrics.team', projectId);
      // Without the team's metrics: one's own goals and the team's.
      const rows = await t.goals(projectId, team ? {} : { userId: ctx.userId });
      const tz = (await t.project(projectId))?.timezone ?? 'UTC';
      const today = await t.projectToday(projectId);
      return Promise.all(
        rows.map(async (g) => {
          const f = g.frequency as Frequency;
          const periodTarget = g.target * windowsIn(f, g.startsOn, g.endsOn);
          const periodCompletes = await this.completes(t, projectId, g, g.startsOn, g.endsOn, tz);
          // The window shown: today's, or the first or last one outside the dates.
          const ref = today < g.startsOn ? g.startsOn : today > g.endsOn ? g.endsOn : today;
          const win = windowOf(f, g.startsOn, g.endsOn, ref);
          const done = win
            ? f === 'period'
              ? periodCompletes
              : await this.completes(t, projectId, g, win.from, win.to, tz)
            : 0;
          const total = win ? daysBetween(win.from, win.to) : 1;
          const elapsed = win ? Math.max(0, Math.min(total, daysBetween(win.from, today))) : 0;
          const expected = Math.round((g.target * elapsed) / total);
          return {
            ...g,
            name: g.name ?? null,
            windowFrom: win?.from ?? null,
            windowTo: win?.to ?? null,
            completes: done,
            percent: Math.round((100 * done) / g.target),
            expectedByToday: expected,
            periodCompletes,
            periodTarget,
            state:
              today < g.startsOn
                ? 'upcoming'
                : today > g.endsOn
                  ? periodCompletes >= periodTarget
                    ? 'met'
                    : 'missed'
                  : !win
                    ? 'rest'
                    : done >= g.target
                      ? 'met'
                      : done >= expected
                        ? 'on_track'
                        : 'behind',
          };
        }),
      );
    });
  }

  private completes(
    t: MetricsTx,
    projectId: string,
    g: { userId: string | null; questionnaireId: string | null },
    from: string,
    to: string,
    tz: string,
  ) {
    return t.goalCompletes(projectId, g, from, to, tz);
  }

  @Post()
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(GoalBody, { io: 'input' }) as object })
  create(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(GoalBody)) body: z.infer<typeof GoalBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const people = await this.cases.assignees(t, projectId);
      if (body.userId && !people.some((p) => p.userId === body.userId))
        throw new BadRequestException({
          code: 'NOT_ASSIGNEE',
          message: 'Goals are for people who work cases in this project',
        });
      const questionnaireId = body.questionnaireId
        ? await this.cases.questionnaireFor(t, projectId, body.questionnaireId)
        : null;
      return t.insertGoal({
        projectId,
        userId: body.userId,
        frequency: body.frequency,
        questionnaireId,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        target: body.target,
        createdBy: ctx.userId,
      });
    });
  }

  @Patch(':goalId')
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(GoalPatch) as object })
  update(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @Body(new ZodPipe(GoalPatch)) body: z.infer<typeof GoalPatch>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const before = await t.goal(projectId, goalId);
      if (!before) throw new NotFoundException('Goal not found');
      const next = { ...before, ...body };
      if (next.endsOn < next.startsOn)
        throw new BadRequestException('The period ends before it starts');
      return t.updateGoal(goalId, body);
    });
  }

  @Delete(':goalId')
  @RequirePermission('cases.assign', PERM)
  remove(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      if (!(await t.deleteGoal(projectId, goalId))) throw new NotFoundException('Goal not found');
      return { ok: true };
    });
  }
}
