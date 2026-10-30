import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { SAMPLES } from '@wansurvey/fixtures';
import { analyze } from '@wansurvey/logic';
import { Mode, Questionnaire, Scenario, VersionMapping } from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { DisplayName, ZodPipe } from '../common/zod.js';
import {
  QUESTIONNAIRES_REPO,
  type QuestionnaireView,
  type QuestionnairesRepo,
  type QuestionnairesTx,
} from './questionnaires-repo.js';
import { checkDraft } from './publish-checks.js';
import { QUESTIONNAIRE_STATES } from './state.js';

const Definition = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  name: DisplayName,
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
  name: DisplayName.optional(),
});

const PublishBody = z.object({
  baseRevision: z.number().int().positive(),
  mapping: VersionMapping.optional(),
});
const CheckBody = PublishBody.partial();

const ScenarioBody = z.object({ scenario: Scenario });
const RenameBody = z.object({ name: DisplayName });
const StateBody = z.object({
  state: z.enum(QUESTIONNAIRE_STATES),
  /** With `completed`: the questionnaire its web links continue in. */
  successorId: z.uuid().nullable().default(null),
});

/** Draft saves are audited at most once per editor and questionnaire in this window. */
const DRAFT_AUDIT_WINDOW_MS = 5 * 60_000;

const BASE = 'projects/:projectId/questionnaires';
const PERM = { projectParam: 'projectId' } as const;

@ApiTags('questionnaires')
@Controller(BASE)
export class QuestionnairesController {
  constructor(
    @Inject(QUESTIONNAIRES_REPO) private readonly repo: QuestionnairesRepo,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('questionnaires.read', PERM)
  list(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.project(t, projectId);
      const rows = await t.list(projectId);
      const versions = await t.versionsOf(rows.map((r) => r.id));
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const project = await this.project(t, projectId);
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
        const found = await t.versionDefinition(projectId, src.questionnaireId, src.version);
        if (!found) throw new NotFoundException('Version not found');
        definition = found;
      } else if (src.kind === 'json') {
        definition = src.definition;
      } else {
        definition = blankQuestionnaire(body.name);
      }
      // The chosen modes replace those of a sample, a copied version or a file.
      definition = { ...definition, modes: body.modes };
      const id = await t.create({
        projectId,
        name: body.name,
        draft: definition,
        userId: ctx.userId,
      });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'questionnaire.created',
          targetType: 'questionnaire',
          targetId: id,
          details: { projectId, name: body.name, source: src.kind },
        }),
      );
      return this.load(t, projectId, id);
    });
  }

  @Get(':qid')
  @RequirePermission('questionnaires.read', PERM)
  get(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, (t) => this.load(t, projectId, qid));
  }

  /** Renames a questionnaire (its draft and versions are unchanged). */
  @Patch(':qid')
  @RequirePermission('questionnaires.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(RenameBody) as object })
  rename(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(RenameBody)) body: z.infer<typeof RenameBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await t.rename(projectId, qid, body.name, ctx.userId);
      if (!row) throw new NotFoundException('Questionnaire not found');
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'questionnaire.renamed',
          targetType: 'questionnaire',
          targetId: qid,
          details: { name: body.name },
        }),
      );
      return row;
    });
  }

  /**
   * Deletes a questionnaire that was never fielded: no published version, web wave, invitation
   * or open link (409 IN_USE otherwise; retire its versions instead).
   */
  @Delete(':qid')
  @HttpCode(204)
  @RequirePermission('questionnaires.edit', PERM)
  async remove(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ): Promise<void> {
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      const current = await this.lockDraft(t, projectId, qid);
      if (await t.inUse(qid))
        throw new ConflictException({
          code: 'IN_USE',
          message: 'The questionnaire has been published or used for web surveys',
        });
      await t.remove(qid);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'questionnaire.deleted',
          targetType: 'questionnaire',
          targetId: qid,
          details: { projectId, name: current.name },
        }),
      );
    });
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const current = await this.lockDraft(t, projectId, qid);
      if (current.draftRevision !== body.baseRevision) throw await this.conflict(t, current);
      const row = await t.saveDraft(qid, {
        draft: body.definition,
        revision: current.draftRevision + 1,
        userId: ctx.userId,
        name: body.name,
      });
      const recent = await t.savedDraftSince(
        qid,
        ctx.userId,
        new Date(Date.now() - DRAFT_AUDIT_WINDOW_MS),
      );
      if (!recent || (body.name && body.name !== current.name)) {
        await t.audit(
          this.audit.fromContext(ctx, {
            action: 'questionnaire.draft_saved',
            targetType: 'questionnaire',
            targetId: qid,
            details: {
              revision: row.draftRevision,
              ...(body.name && body.name !== current.name ? { name: body.name } : {}),
            },
          }),
        );
      }
      return { ...row, diagnostics: diagnosticsOf(body.definition) };
    });
  }

  @Get(':qid/versions')
  @RequirePermission('questionnaires.read', PERM)
  versions(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      return t.versions(qid);
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const v = await t.version(qid, version);
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const q = await this.questionnaire(t, projectId, qid);
      const { check } = checkDraft(
        q.draft,
        await t.scenarios(qid),
        await t.previous(qid),
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      // The row lock serialises publishes (and saves) of this questionnaire.
      const q = await this.lockDraft(t, projectId, qid);
      if (q.draftRevision !== body.baseRevision) throw await this.conflict(t, q);
      const previous = await t.previous(qid);
      const { check, questionnaire, compiled } = checkDraft(
        q.draft,
        await t.scenarios(qid),
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
      const row = await t.publish({
        questionnaireId: qid,
        version,
        definition: questionnaire,
        compiled,
        mapping: check.breaking.length ? (body.mapping ?? null) : null,
        userId: ctx.userId,
      });
      await t.audit(
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const row = await t.retire(qid, version);
      if (!row) throw new NotFoundException('No published version with that number');
      await t.audit(
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

  /**
   * Disables a questionnaire (no new fills in any mode; what was started can still be sent),
   * enables it again, or completes it: no new fills, its pending cases close as
   * FIELDWORK_CLOSED, and its web links may continue in another questionnaire.
   */
  @Post(':qid/state')
  @HttpCode(200)
  @RequirePermission('questionnaires.publish', PERM)
  @ApiBody({ schema: z.toJSONSchema(StateBody, { io: 'input' }) as object })
  setState(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
    @Body(new ZodPipe(StateBody)) body: z.infer<typeof StateBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const before = await this.questionnaire(t, projectId, qid);
      const successorId = body.state === 'completed' ? body.successorId : null;
      if (successorId) {
        const next = await t.sibling(projectId, successorId);
        if (!next || next.id === qid || next.state !== 'active')
          throw new BadRequestException({
            code: 'BAD_SUCCESSOR',
            message: 'The continuation must be another active questionnaire of the project',
          });
      }
      const row = await t.setState(qid, body.state, successorId);
      // Completing closes what is still pending; what is being interviewed is left to finish.
      const closed = body.state === 'completed' ? await t.closePendingCases(qid, ctx.userId) : 0;
      await t.audit(
        this.audit.fromContext(ctx, {
          action:
            body.state === 'disabled'
              ? 'questionnaire.disabled'
              : body.state === 'completed'
                ? 'questionnaire.completed'
                : 'questionnaire.enabled',
          targetType: 'questionnaire',
          targetId: qid,
          details: { from: before.state, successorId, casesClosed: closed },
        }),
      );
      return { ...row, casesClosed: closed };
    });
  }

  @Get(':qid/scenarios')
  @RequirePermission('questionnaires.read', PERM)
  scenarios(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('qid', ParseUUIDPipe) qid: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      return t.scenarios(qid);
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const row = await t.saveScenario({
        questionnaireId: qid,
        name: body.scenario.name,
        scenario: body.scenario,
        userId: ctx.userId,
      });
      await t.audit(
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
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.questionnaire(t, projectId, qid);
      const name = await t.deleteScenario(qid, sid);
      if (name === null) throw new NotFoundException('Scenario not found');
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'questionnaire.scenario_deleted',
          targetType: 'questionnaire',
          targetId: qid,
          details: { scenario: name },
        }),
      );
    });
  }

  // -------------------------------------------------------------------------

  private async project(t: QuestionnairesTx, projectId: string) {
    const p = await t.project(projectId);
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  private async questionnaire(t: QuestionnairesTx, projectId: string, qid: string) {
    const q = await t.get(projectId, qid);
    if (!q) throw new NotFoundException('Questionnaire not found');
    return q;
  }

  private async lockDraft(t: QuestionnairesTx, projectId: string, qid: string) {
    const q = await t.lock(projectId, qid);
    if (!q) throw new NotFoundException('Questionnaire not found');
    return q;
  }

  private async conflict(t: QuestionnairesTx, current: QuestionnaireView) {
    const who = current.updatedBy ? await t.userName(current.updatedBy) : null;
    return new ConflictException({
      code: 'DRAFT_CONFLICT',
      message: 'Someone else saved this questionnaire in the meantime',
      currentRevision: current.draftRevision,
      updatedBy: who,
      updatedAt: current.updatedAt,
    });
  }

  private async load(t: QuestionnairesTx, projectId: string, qid: string) {
    const q = await this.questionnaire(t, projectId, qid);
    const who = q.updatedBy ? await t.userName(q.updatedBy) : null;
    return {
      id: q.id,
      projectId: q.projectId,
      name: q.name,
      draft: q.draft,
      draftRevision: q.draftRevision,
      updatedAt: q.updatedAt,
      updatedBy: who,
      latestVersion: await t.latestVersion(qid),
    };
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

/** An id from the name, as exports show it: SATISFACCION_CON_SERVICIOS. */
export function questionnaireIdFrom(name: string): string {
  const id = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  return /^[A-Z]/.test(id) ? id : id ? `Q_${id}`.slice(0, 32) : 'QUESTIONNAIRE';
}

/**
 * A new questionnaire: one empty section, in Spanish. Interviews are conducted in Spanish;
 * other languages are added to the questionnaire when needed (L43).
 */
export function blankQuestionnaire(name: string): Record<string, unknown> {
  return {
    id: questionnaireIdFrom(name),
    title: { es: name },
    defaultLanguage: 'es',
    languages: ['es'],
    sections: [{ id: 'SEC_A', title: { es: 'Sección A' }, items: [] }],
  };
}
