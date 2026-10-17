import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Auth, can, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CasesService } from '../cases/cases.service.js';
import { Database, type Tx } from '../db/database.js';
import { interviewerGoals, projects, users } from '../db/schema.js';
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
    private readonly database: Database,
    private readonly cases: CasesService,
  ) {}

  @Get()
  @RequirePermission(['metrics.team', 'metrics.own'], PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const team = can(ctx.memberships, 'metrics.team', projectId);
      const rows = await tx
        .select({
          id: interviewerGoals.id,
          userId: interviewerGoals.userId,
          name: users.name,
          frequency: interviewerGoals.frequency,
          questionnaireId: interviewerGoals.questionnaireId,
          startsOn: interviewerGoals.startsOn,
          endsOn: interviewerGoals.endsOn,
          target: interviewerGoals.target,
        })
        .from(interviewerGoals)
        .leftJoin(users, eq(users.id, interviewerGoals.userId))
        .where(
          and(
            eq(interviewerGoals.projectId, projectId),
            // Without the team's metrics: one's own goals and the team's.
            team
              ? undefined
              : or(eq(interviewerGoals.userId, ctx.userId), isNull(interviewerGoals.userId)),
          ),
        )
        .orderBy(asc(interviewerGoals.startsOn), asc(users.name));
      const [p] = await tx
        .select({ timezone: projects.timezone })
        .from(projects)
        .where(eq(projects.id, projectId));
      const tz = p?.timezone ?? 'UTC';
      const today = (
        (await tx.execute(sql`select (now() at time zone ${tz})::date::text as d`)) as unknown as {
          d: string;
        }[]
      )[0]!.d;
      return Promise.all(
        rows.map(async (g) => {
          const f = g.frequency as Frequency;
          const periodTarget = g.target * windowsIn(f, g.startsOn, g.endsOn);
          const periodCompletes = await this.completes(tx, projectId, g, g.startsOn, g.endsOn, tz);
          // The window shown: today's, or the first or last one outside the dates.
          const ref = today < g.startsOn ? g.startsOn : today > g.endsOn ? g.endsOn : today;
          const win = windowOf(f, g.startsOn, g.endsOn, ref);
          const done = win
            ? f === 'period'
              ? periodCompletes
              : await this.completes(tx, projectId, g, win.from, win.to, tz)
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

  private async completes(
    tx: Tx,
    projectId: string,
    g: { userId: string | null; questionnaireId: string | null },
    from: string,
    to: string,
    tz: string,
  ) {
    const [r] = (await tx.execute(sql`
      select count(*)::int as n
      from interviews i
      join questionnaire_versions v on v.id = i.questionnaire_version_id
      where i.project_id = ${projectId}
        ${g.userId ? sql`and i.interviewer_id = ${g.userId}` : sql``}
        and i.disposition = 'COMPLETE'
        and i.status in ('submitted', 'in_review', 'approved', 'returned')
        and (i.submitted_at at time zone ${tz})::date between ${from}::date and ${to}::date
        ${g.questionnaireId ? sql`and v.questionnaire_id = ${g.questionnaireId}` : sql``}
    `)) as unknown as { n: number }[];
    return r?.n ?? 0;
  }

  @Post()
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(GoalBody, { io: 'input' }) as object })
  create(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(GoalBody)) body: z.infer<typeof GoalBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const people = await this.cases.assignees(tx, projectId);
      if (body.userId && !people.some((p) => p.userId === body.userId))
        throw new BadRequestException({
          code: 'NOT_ASSIGNEE',
          message: 'Goals are for people who work cases in this project',
        });
      const questionnaireId = body.questionnaireId
        ? await this.cases.questionnaireFor(tx, projectId, body.questionnaireId)
        : null;
      const [row] = await tx
        .insert(interviewerGoals)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          ...body,
          questionnaireId,
          createdBy: ctx.userId,
        })
        .returning();
      return row!;
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(interviewerGoals)
        .where(and(eq(interviewerGoals.id, goalId), eq(interviewerGoals.projectId, projectId)));
      if (!before) throw new NotFoundException('Goal not found');
      const next = { ...before, ...body };
      if (next.endsOn < next.startsOn)
        throw new BadRequestException('The period ends before it starts');
      const [row] = await tx
        .update(interviewerGoals)
        .set(body)
        .where(eq(interviewerGoals.id, goalId))
        .returning();
      return row!;
    });
  }

  @Delete(':goalId')
  @RequirePermission('cases.assign', PERM)
  remove(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const r = await tx
        .delete(interviewerGoals)
        .where(and(eq(interviewerGoals.id, goalId), eq(interviewerGoals.projectId, projectId)))
        .returning({ id: interviewerGoals.id });
      if (!r.length) throw new NotFoundException('Goal not found');
      return { ok: true };
    });
  }
}
