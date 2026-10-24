import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { assignments, cases, users } from '../db/schema.js';
import { compileRule, ruleError } from './case-logic.js';
import { CasesService, ofQuestionnaire } from './cases.service.js';

const PERM = { projectParam: 'projectId' } as const;

const RuleBody = z.object({
  userId: z.uuid(),
  /** The questionnaire whose cases the rule hands out; left out: every case of the project. */
  questionnaireId: z.uuid().nullable().optional(),
  name: z.string().max(200).optional(),
  filter: z.string().min(1).max(2000),
  quota: z.number().int().min(1).max(1_000_000).nullable().optional(),
  active: z.boolean().optional(),
});
const RulePatch = RuleBody.partial();
const QuestionnaireQuery = z.object({ questionnaireId: z.uuid().optional() });
/** Runs the rules: one rule, or all; over some cases (the selected ones), or every free one. */
const ApplyBody = z.object({
  ruleId: z.uuid().optional(),
  caseIds: z.array(z.uuid()).max(50_000).optional(),
  questionnaireId: z.uuid().optional(),
});

/** Assignment rules: who gets which cases, by a filter and a quota (C5). */
@ApiTags('cases')
@Controller('projects/:projectId')
export class AssignmentRulesController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly svc: CasesService,
  ) {}

  @Get('assignments')
  @RequirePermission('cases.assign', PERM)
  rules(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(QuestionnaireQuery)) q: z.infer<typeof QuestionnaireQuery>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: assignments.id,
          userId: assignments.userId,
          questionnaireId: assignments.questionnaireId,
          userName: users.name,
          name: assignments.name,
          filter: assignments.filter,
          quota: assignments.quota,
          active: assignments.active,
          createdAt: assignments.createdAt,
        })
        .from(assignments)
        .innerJoin(users, eq(users.id, assignments.userId))
        .where(
          and(
            eq(assignments.projectId, projectId),
            // A questionnaire's rules and the project-wide ones.
            q.questionnaireId
              ? or(
                  eq(assignments.questionnaireId, q.questionnaireId),
                  isNull(assignments.questionnaireId),
                )
              : undefined,
          ),
        )
        .orderBy(asc(assignments.createdAt));
      const all = this.svc.openRows(
        await this.svc.selectCases(tx).where(eq(cases.projectId, projectId)),
      );
      return rows.map((r) => {
        const match = compileRule(r.filter);
        const matching = all
          .filter(
            (c) =>
              !r.questionnaireId ||
              c.questionnaireId === r.questionnaireId ||
              c.questionnaireId === null,
          )
          .filter(match);
        return {
          ...r,
          matching: matching.length,
          unassigned: matching.filter((c) => !c.assignedTo && c.status === 'fresh').length,
          assignedToUser: matching.filter((c) => c.assignedTo === r.userId).length,
        };
      });
    });
  }

  /** How many cases a filter matches (for the rule editor and bulk assignment). */
  @Post('assignments/preview')
  @HttpCode(200)
  @RequirePermission('cases.assign', PERM)
  preview(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(
      new ZodPipe(z.object({ filter: z.string().max(2000), questionnaireId: z.uuid().optional() })),
    )
    body: { filter: string; questionnaireId?: string },
  ) {
    const err = body.filter.trim() ? ruleError(body.filter) : null;
    if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const match = compileRule(body.filter);
      const all = this.svc
        .openRows(
          await this.svc
            .selectCases(tx)
            .where(and(eq(cases.projectId, projectId), ofQuestionnaire(body.questionnaireId))),
        )
        .filter(match);
      return {
        matching: all.length,
        unassigned: all.filter((c) => !c.assignedTo && c.status === 'fresh').length,
      };
    });
  }

  @Post('assignments')
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(RuleBody) as object })
  createRule(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>,
  ) {
    const err = ruleError(body.filter);
    if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.svc.project(tx, projectId);
      await this.svc.assertAssignee(tx, projectId, body.userId);
      const questionnaireId = body.questionnaireId
        ? await this.svc.questionnaireFor(tx, projectId, body.questionnaireId)
        : null;
      const [row] = await tx
        .insert(assignments)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          userId: body.userId,
          questionnaireId,
          kind: 'rule',
          name: body.name ?? null,
          filter: body.filter,
          quota: body.quota ?? null,
          active: body.active ?? true,
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'assignment.created',
          targetType: 'assignment',
          targetId: row!.id,
          details: {
            projectId,
            userId: body.userId,
            filter: body.filter,
            quota: body.quota ?? null,
          },
        }),
      );
      return row;
    });
  }

  @Patch('assignments/:ruleId')
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(RulePatch) as object })
  updateRule(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body(new ZodPipe(RulePatch)) body: z.infer<typeof RulePatch>,
  ) {
    if (body.filter) {
      const err = ruleError(body.filter);
      if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
    }
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      if (body.userId) await this.svc.assertAssignee(tx, projectId, body.userId);
      const [row] = await tx
        .update(assignments)
        .set(body)
        .where(and(eq(assignments.id, ruleId), eq(assignments.projectId, projectId)))
        .returning();
      if (!row) throw new NotFoundException('Rule not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'assignment.updated',
          targetType: 'assignment',
          targetId: ruleId,
          details: body,
        }),
      );
      return row;
    });
  }

  @Delete('assignments/:ruleId')
  @HttpCode(204)
  @RequirePermission('cases.assign', PERM)
  async deleteRule(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<void> {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .delete(assignments)
        .where(and(eq(assignments.id, ruleId), eq(assignments.projectId, projectId)))
        .returning({ id: assignments.id });
      if (!row) throw new NotFoundException('Rule not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'assignment.deleted',
          targetType: 'assignment',
          targetId: ruleId,
          details: { projectId },
        }),
      );
    });
  }

  /** Runs the active rules (or one rule) over the unassigned fresh cases now. */
  @Post('assignments/apply')
  @HttpCode(200)
  @RequirePermission('cases.assign', PERM)
  apply(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(ApplyBody)) body: z.infer<typeof ApplyBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.svc.project(tx, projectId);
      const n = await this.svc.applyRules(tx, ctx, projectId, {
        ...(body.ruleId ? { ruleId: body.ruleId } : {}),
        ...(body.caseIds ? { onlyCaseIds: body.caseIds } : {}),
        ...(body.questionnaireId ? { questionnaireId: body.questionnaireId } : {}),
      });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'cases.assigned',
          targetType: 'project',
          targetId: projectId,
          details: { via: 'rules', ruleId: body.ruleId ?? null, count: n },
        }),
      );
      return { assigned: n };
    });
  }
}
