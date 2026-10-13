import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { SAMPLES } from '@wansurvey/fixtures';
import { analyze } from '@wansurvey/logic';
import { Mode, Questionnaire, Scenario, VersionMapping } from '@wansurvey/schema';
import { and, desc, eq, gte, inArray, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
import {
  auditLog,
  projects,
  questionnaireScenarios,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import { checkDraft, type PreviousVersion } from './publish-checks.js';

const Definition = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  /** The modes it is fielded in, chosen at creation (Q1); within the project's modes. */
  modes: z
    .array(Mode)
    .min(1)
    .refine((m) => new Set(m).size === m.length, { message: 'Each mode once' }),
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('blank') }),
      z.object({ kind: z.literal('sample'), id: z.string() }),
      z.object({
        kind: z.literal('version'),
        questionnaireId: z.uuid(),
        version: z.number().int().positive(),
      }),
      z.object({ kind: z.literal('json'), definition: Definition }),
    ])
    .default({ kind: 'blank' }),
});

const DraftBody = z.object({
  definition: Definition,
  baseRevision: z.number().int().positive(),
  name: z.string().min(1).max(200).optional(),
});

const PublishBody = z.object({
  baseRevision: z.number().int().positive(),
  mapping: VersionMapping.optional(),
});
const CheckBody = PublishBody.partial();

const ScenarioBody = z.object({ scenario: Scenario });

/** Draft saves are audited at most once per editor and questionnaire in this window. */
const DRAFT_AUDIT_WINDOW_MS = 5 * 60_000;

const BASE = 'projects/:projectId/questionnaires';
const PERM = { projectParam: 'projectId' } as const;

@ApiTags('questionnaires')
@Controller(BASE)
export class QuestionnairesController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('questionnaires.read', PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.project(tx, projectId);
      const rows = await tx
        .select({
          id: questionnaires.id,
          name: questionnaires.name,
          draftRevision: questionnaires.draftRevision,
          updatedAt: questionnaires.updatedAt,
          modes: sql<string[] | null>`${questionnaires.draft} -> 'modes'`,
        })
        .from(questionnaires)
        .where(eq(questionnaires.projectId, projectId))
        .orderBy(questionnaires.name);
      const versions = rows.length
        ? await tx
            .select({
              questionnaireId: questionnaireVersions.questionnaireId,
              version: questionnaireVersions.version,
              status: questionnaireVersions.status,
              publishedAt: questionnaireVersions.publishedAt,
            })
            .from(questionnaireVersions)
            .where(
              inArray(
                questionnaireVersions.questionnaireId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(desc(questionnaireVersions.version))
        : [];
      return rows.map((r) => {
        const own = versions.filter((v) => v.questionnaireId === r.id);
        return {
          ...r,
          // Drafts written before modes existed are fielded in all four.
          modes:
            Array.isArray(r.modes) && r.modes.length ? r.modes : ['CATI', 'CAPI', 'CAWI', 'PAPI'],
          latestVersion: own[0] ?? null,
          publishedVersions: own.filter((v) => v.status === 'published').length,
        };
      });
    });
  }

  @Post()
  @RequirePermission('questionnaires.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(CreateBody) as object })
  create(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const project = await this.project(tx, projectId);
      const outside = project.modesEnabled.length
        ? body.modes.filter((m) => !project.modesEnabled.includes(m))
        : [];
      if (outside.length)
        throw new BadRequestException({
          code: 'MODES_NOT_IN_PROJECT',
          message: `The project does not use ${outside.join(', ')}`,
          modes: outside,
        });
      let definition: Record<string, unknown>;
      const src = body.source;
      if (src.kind === 'sample') {
        const sample = SAMPLES.find((s) => s.id === src.id);
        if (!sample) throw new NotFoundException('Sample not found');
        definition = structuredClone(sample.questionnaire) as Record<string, unknown>;
      } else if (src.kind === 'version') {
        // A copy of a version of any questionnaire in the same project.
        const [v] = await tx
          .select({ definition: questionnaireVersions.definition })
          .from(questionnaireVersions)
          .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
          .where(
            and(
              eq(questionnaireVersions.questionnaireId, src.questionnaireId),
              eq(questionnaireVersions.version, src.version),
              eq(questionnaires.projectId, projectId),
            ),
          );
        if (!v) throw new NotFoundException('Version not found');
        definition = v.definition as Record<string, unknown>;
      } else if (src.kind === 'json') {
        definition = src.definition;
      } else {
        definition = blankQuestionnaire(body.name);
      }
      // The chosen modes replace those of a sample, a copied version or a file.
      definition = { ...definition, modes: body.modes };
      const [row] = await tx
        .insert(questionnaires)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          name: body.name,
          draft: definition,
          updatedBy: ctx.userId,
        })
        .returning({ id: questionnaires.id });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'questionnaire.created',
          targetType: 'questionnaire',
          targetId: row!.id,
          details: { projectId, name: body.name, source: src.kind },
        }),
      );
      return this.load(tx, projectId, row!.id);
    });
  }

  @Get(':qid')
  @RequirePermission('questionnaires.read', PERM)
  get(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.database.withTenant(ctx.tenantId, (tx) => this.load(tx, projectId, qid));
  }

  /**
   * Saves the draft if nobody else saved since `baseRevision` (optimistic locking). Invalid
   * drafts are saved too, so work in progress is never lost; diagnostics come back with it.
   */
  @Put(':qid/draft')
  @RequirePermission('questionnaires.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(DraftBody) as object })
  saveDraft(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(DraftBody)) body: z.infer<typeof DraftBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const current = await this.lockDraft(tx, projectId, qid);
      if (current.draftRevision !== body.baseRevision) throw await this.conflict(tx, current);
      const [row] = await tx
        .update(questionnaires)
        .set({
          draft: body.definition,
          draftRevision: current.draftRevision + 1,
          updatedBy: ctx.userId,
          updatedAt: new Date(),
          ...(body.name ? { name: body.name } : {}),
        })
        .where(eq(questionnaires.id, qid))
        .returning({
          draftRevision: questionnaires.draftRevision,
          updatedAt: questionnaires.updatedAt,
        });
      const [recent] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'questionnaire.draft_saved'),
            eq(auditLog.targetId, qid),
            eq(auditLog.actorUserId, ctx.userId),
            gte(auditLog.at, new Date(Date.now() - DRAFT_AUDIT_WINDOW_MS)),
          ),
        )
        .limit(1);
      if (!recent || (body.name && body.name !== current.name)) {
        await this.audit.record(
          tx,
          ctx.tenantId,
          this.audit.fromContext(ctx, {
            action: 'questionnaire.draft_saved',
            targetType: 'questionnaire',
            targetId: qid,
            details: {
              revision: row!.draftRevision,
              ...(body.name && body.name !== current.name ? { name: body.name } : {}),
            },
          }),
        );
      }
      return { ...row!, diagnostics: diagnosticsOf(body.definition) };
    });
  }

  @Get(':qid/versions')
  @RequirePermission('questionnaires.read', PERM)
  versions(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      return tx
        .select({
          version: questionnaireVersions.version,
          status: questionnaireVersions.status,
          hash: questionnaireVersions.hash,
          hasMapping: sql<boolean>`${questionnaireVersions.mapping} is not null`,
          publishedAt: questionnaireVersions.publishedAt,
          publishedBy: users.name,
          retiredAt: questionnaireVersions.retiredAt,
        })
        .from(questionnaireVersions)
        .leftJoin(users, eq(users.id, questionnaireVersions.publishedBy))
        .where(eq(questionnaireVersions.questionnaireId, qid))
        .orderBy(desc(questionnaireVersions.version));
    });
  }

  @Get(':qid/versions/:version')
  @RequirePermission('questionnaires.read', PERM)
  version(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const [v] = await tx
        .select()
        .from(questionnaireVersions)
        .where(
          and(
            eq(questionnaireVersions.questionnaireId, qid),
            eq(questionnaireVersions.version, version),
          ),
        );
      if (!v) throw new NotFoundException('Version not found');
      return v;
    });
  }

  /** Dry run of publishing: what would block it, and which changes need a mapping. */
  @Post(':qid/publish-check')
  @HttpCode(200)
  @RequirePermission('questionnaires.publish', PERM)
  @ApiBody({ schema: z.toJSONSchema(CheckBody) as object })
  publishCheck(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(CheckBody)) body: z.infer<typeof CheckBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const q = await this.questionnaire(tx, projectId, qid);
      const { check } = checkDraft(
        q.draft,
        await this.scenarioRows(tx, qid),
        await this.previous(tx, qid),
        body.mapping,
      );
      return { ...check, draftRevision: q.draftRevision };
    });
  }

  @Post(':qid/publish')
  @RequirePermission('questionnaires.publish', PERM)
  @ApiBody({ schema: z.toJSONSchema(PublishBody) as object })
  publish(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(PublishBody)) body: z.infer<typeof PublishBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      // The row lock serialises publishes (and saves) of this questionnaire.
      const q = await this.lockDraft(tx, projectId, qid);
      if (q.draftRevision !== body.baseRevision) throw await this.conflict(tx, q);
      const previous = await this.previous(tx, qid);
      const { check, questionnaire, compiled } = checkDraft(
        q.draft,
        await this.scenarioRows(tx, qid),
        previous,
        body.mapping,
      );
      if (check.unchanged) {
        throw new ConflictException({
          code: 'NOTHING_TO_PUBLISH',
          message: `The draft is identical to version ${previous!.version}`,
        });
      }
      if (!check.ok || !compiled || !questionnaire) {
        throw new UnprocessableEntityException({
          code: 'PUBLISH_BLOCKED',
          message: 'The questionnaire cannot be published yet',
          check,
        });
      }
      const version = (previous?.version ?? 0) + 1;
      const [row] = await tx
        .insert(questionnaireVersions)
        .values({
          tenantId: ctx.tenantId,
          questionnaireId: qid,
          version,
          definition: questionnaire,
          compiled,
          hash: compiled.hash,
          mapping: check.breaking.length ? (body.mapping ?? null) : null,
          publishedBy: ctx.userId,
        })
        .returning({
          version: questionnaireVersions.version,
          status: questionnaireVersions.status,
          hash: questionnaireVersions.hash,
          publishedAt: questionnaireVersions.publishedAt,
        });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'questionnaire.published',
          targetType: 'questionnaire',
          targetId: qid,
          details: {
            version,
            hash: compiled.hash,
            breakingChanges: check.breaking.map((b) => b.id),
            scenarios: check.scenarios.length,
          },
        }),
      );
      return row;
    });
  }

  @Post(':qid/versions/:version/retire')
  @HttpCode(200)
  @RequirePermission('questionnaires.publish', PERM)
  retire(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const [row] = await tx
        .update(questionnaireVersions)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(
          and(
            eq(questionnaireVersions.questionnaireId, qid),
            eq(questionnaireVersions.version, version),
            eq(questionnaireVersions.status, 'published'),
          ),
        )
        .returning({
          version: questionnaireVersions.version,
          status: questionnaireVersions.status,
          retiredAt: questionnaireVersions.retiredAt,
        });
      if (!row) throw new NotFoundException('No published version with that number');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'questionnaire.version_retired',
          targetType: 'questionnaire',
          targetId: qid,
          details: { version },
        }),
      );
      return row;
    });
  }

  @Get(':qid/scenarios')
  @RequirePermission('questionnaires.read', PERM)
  scenarios(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      return tx
        .select({
          id: questionnaireScenarios.id,
          name: questionnaireScenarios.name,
          scenario: questionnaireScenarios.scenario,
          updatedAt: questionnaireScenarios.updatedAt,
        })
        .from(questionnaireScenarios)
        .where(eq(questionnaireScenarios.questionnaireId, qid))
        .orderBy(questionnaireScenarios.name);
    });
  }

  /** Creates or replaces the scenario with this name. */
  @Put(':qid/scenarios')
  @RequirePermission('questionnaires.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(ScenarioBody) as object })
  saveScenario(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(ScenarioBody)) body: z.infer<typeof ScenarioBody>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const [row] = await tx
        .insert(questionnaireScenarios)
        .values({
          tenantId: ctx.tenantId,
          questionnaireId: qid,
          name: body.scenario.name,
          scenario: body.scenario,
          createdBy: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [questionnaireScenarios.questionnaireId, questionnaireScenarios.name],
          set: { scenario: body.scenario, updatedAt: new Date() },
        })
        .returning({
          id: questionnaireScenarios.id,
          name: questionnaireScenarios.name,
          updatedAt: questionnaireScenarios.updatedAt,
        });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'questionnaire.scenario_saved',
          targetType: 'questionnaire',
          targetId: qid,
          details: { scenario: body.scenario.name },
        }),
      );
      return row;
    });
  }

  @Delete(':qid/scenarios/:sid')
  @HttpCode(204)
  @RequirePermission('questionnaires.edit', PERM)
  async deleteScenario(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Param('sid', ParseUUIDPipe) sid: string,
  ): Promise<void> {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.questionnaire(tx, projectId, qid);
      const [row] = await tx
        .delete(questionnaireScenarios)
        .where(
          and(eq(questionnaireScenarios.id, sid), eq(questionnaireScenarios.questionnaireId, qid)),
        )
        .returning({ name: questionnaireScenarios.name });
      if (!row) throw new NotFoundException('Scenario not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'questionnaire.scenario_deleted',
          targetType: 'questionnaire',
          targetId: qid,
          details: { scenario: row.name },
        }),
      );
    });
  }

  // -------------------------------------------------------------------------

  private async project(tx: Tx, projectId: string) {
    const [p] = await tx
      .select({
        id: projects.id,
        languages: projects.languages,
        modesEnabled: projects.modesEnabled,
      })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  private async questionnaire(tx: Tx, projectId: string, qid: string) {
    const [q] = await tx
      .select()
      .from(questionnaires)
      .where(and(eq(questionnaires.id, qid), eq(questionnaires.projectId, projectId)));
    if (!q) throw new NotFoundException('Questionnaire not found');
    return q;
  }

  private async lockDraft(tx: Tx, projectId: string, qid: string) {
    const [q] = await tx
      .select()
      .from(questionnaires)
      .where(and(eq(questionnaires.id, qid), eq(questionnaires.projectId, projectId)))
      .for('update');
    if (!q) throw new NotFoundException('Questionnaire not found');
    return q;
  }

  private async conflict(tx: Tx, current: typeof questionnaires.$inferSelect) {
    const [who] = current.updatedBy
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, current.updatedBy))
      : [];
    return new ConflictException({
      code: 'DRAFT_CONFLICT',
      message: 'Someone else saved this questionnaire in the meantime',
      currentRevision: current.draftRevision,
      updatedBy: who?.name ?? null,
      updatedAt: current.updatedAt,
    });
  }

  private async load(tx: Tx, projectId: string, qid: string) {
    const q = await this.questionnaire(tx, projectId, qid);
    const [who] = q.updatedBy
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, q.updatedBy))
      : [];
    const [latest] = await tx
      .select({ version: max(questionnaireVersions.version) })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, qid));
    return {
      id: q.id,
      projectId: q.projectId,
      name: q.name,
      draft: q.draft,
      draftRevision: q.draftRevision,
      updatedAt: q.updatedAt,
      updatedBy: who?.name ?? null,
      latestVersion: latest?.version ?? null,
    };
  }

  private scenarioRows(tx: Tx, qid: string) {
    return tx
      .select({
        id: questionnaireScenarios.id,
        name: questionnaireScenarios.name,
        scenario: questionnaireScenarios.scenario,
      })
      .from(questionnaireScenarios)
      .where(eq(questionnaireScenarios.questionnaireId, qid))
      .orderBy(questionnaireScenarios.name);
  }

  private async previous(tx: Tx, qid: string): Promise<PreviousVersion | null> {
    const [v] = await tx
      .select({
        version: questionnaireVersions.version,
        definition: questionnaireVersions.definition,
        hash: questionnaireVersions.hash,
      })
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, qid))
      .orderBy(desc(questionnaireVersions.version))
      .limit(1);
    return v ?? null;
  }
}

function diagnosticsOf(definition: unknown) {
  const parsed = Questionnaire.safeParse(definition);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 50).map((i) => ({
      severity: 'error' as const,
      code: 'format',
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    }));
  }
  return analyze(parsed.data).diagnostics;
}

/**
 * A new questionnaire: one empty section, in Spanish. Interviews are conducted in Spanish;
 * other languages are added to the questionnaire when needed (L43).
 */
export function blankQuestionnaire(name: string): Record<string, unknown> {
  return {
    id: 'QUESTIONNAIRE',
    title: { es: name },
    defaultLanguage: 'es',
    languages: ['es'],
    sections: [{ id: 'SEC_A', title: { es: 'Sección A' }, items: [] }],
  };
}
