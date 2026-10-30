import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CASES_REPO, type CasesRepo } from './cases-repo.js';
import { compileRule, ruleError } from './case-logic.js';
import { CasesService } from './cases.service.js';

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
    @Inject(CASES_REPO) private readonly repo: CasesRepo,
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const rows = await t.rules(projectId, { questionnaireId: q.questionnaireId });
      const all = this.svc.openRows(await t.cases({ projectId }));
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const match = compileRule(body.filter);
      const all = this.svc
        .forRules(
          ctx,
          projectId,
          await this.svc.piiFields(t, projectId),
          this.svc.openRows(await t.cases({ projectId, questionnaireId: body.questionnaireId })),
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.svc.project(t, projectId);
      await this.svc.assertAssignee(t, projectId, body.userId);
      const questionnaireId = body.questionnaireId
        ? await this.svc.questionnaireFor(t, projectId, body.questionnaireId)
        : null;
      const row = await t.createRule({
        projectId,
        userId: body.userId,
        questionnaireId,
        name: body.name ?? null,
        filter: body.filter,
        quota: body.quota ?? null,
        active: body.active ?? true,
        createdBy: ctx.userId,
      });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'assignment.created',
          targetType: 'assignment',
          targetId: row.id,
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      if (body.userId) await this.svc.assertAssignee(t, projectId, body.userId);
      const row = await t.updateRule(projectId, ruleId, body);
      if (!row) throw new NotFoundException('Rule not found');
      await t.audit(
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
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      if (!(await t.deleteRule(projectId, ruleId))) throw new NotFoundException('Rule not found');
      await t.audit(
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.svc.project(t, projectId);
      const n = await this.svc.applyRules(t, ctx, projectId, {
        ...(body.ruleId ? { ruleId: body.ruleId } : {}),
        ...(body.caseIds ? { onlyCaseIds: body.caseIds } : {}),
        ...(body.questionnaireId ? { questionnaireId: body.questionnaireId } : {}),
      });
      await t.audit(
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
