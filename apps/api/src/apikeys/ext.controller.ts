import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { maskSample } from '../cases/case-logic.js';
import { Auth, ExtApi, RequireScope, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { idOrder } from '../db/mssql/order.js';
import { instant } from '../db/mssql/instant.js';

const Page = z.object({
  /** The `next` of the previous page. */
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode<T>(cursor: string | undefined, valid: (v: unknown) => v is T): T | undefined {
  if (!cursor) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (valid(v)) return v;
  } catch {
    // falls through to the error below
  }
  throw new BadRequestException({ code: 'BAD_CURSOR', message: 'Invalid "after" value' });
}
const isIdCursor = (v: unknown): v is { id: string } =>
  !!v && typeof (v as { id?: unknown }).id === 'string';
const isAtCursor = (v: unknown): v is { at: string; id: string } =>
  isIdCursor(v) && typeof (v as { at?: unknown }).at === 'string';

const json = <T>(text: string | null, fallback: T): T =>
  text === null ? fallback : (JSON.parse(text) as T);

/**
 * The integration API, version 1 (ADR 0001): read only, authenticated by a key (`Authorization:
 * Bearer wsk_…`), inside the key's organisation and, when it has one, its project. The shapes
 * here are a contract: they only grow. Personal data never leaves through a key.
 */
@ApiTags('integration')
@ExtApi()
@Controller('ext/v1')
export class ExtController {
  constructor(
    private readonly engine: Engine,
    private readonly audit: AuditService,
  ) {}

  /** A key restricted to a project sees only that project. */
  private assertProject(ctx: AuthContext, projectId: string) {
    const only = ctx.apiKey!.projectId;
    if (only && only !== projectId) throw new NotFoundException('Project not found');
  }

  private async project(tx: MssqlTx, ctx: AuthContext, projectId: string) {
    this.assertProject(ctx, projectId);
    const p = await tx
      .selectFrom('projects')
      .select('id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!p) throw new NotFoundException('Project not found');
  }

  @Get('projects')
  @RequireScope('projects:read')
  projects(@Auth() ctx: AuthContext) {
    const only = ctx.apiKey!.projectId;
    return this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      let q = tx
        .selectFrom('projects')
        .select([
          'id',
          'code',
          'name',
          'status',
          'timezone',
          'languages',
          'modes_enabled',
          'created_at',
        ])
        .orderBy('created_at')
        .orderBy(idOrder);
      if (only) q = q.where('id', '=', only);
      const rows = await q.execute();
      return {
        data: rows.map((p) => ({
          id: p.id.toLowerCase(),
          code: p.code,
          name: p.name,
          status: p.status,
          timezone: p.timezone,
          languages: json<string[]>(p.languages, []),
          modes: json<string[]>(p.modes_enabled, []),
          createdAt: new Date(p.created_at as never).toISOString(),
        })),
      };
    });
  }

  /** Cases of a project, oldest first; personal sample fields are masked. */
  @Get('projects/:projectId/cases')
  @RequireScope('cases:read')
  cases(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(Page.extend({ status: z.string().max(40).optional() })))
    q: z.infer<typeof Page> & { status?: string },
  ) {
    const after = decode(q.after, isIdCursor);
    return this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      await this.project(tx, ctx, projectId);
      const pii = new Set(
        (
          await tx
            .selectFrom('sample_fields')
            .select('name')
            .where('project_id', '=', projectId)
            .where('pii', '=', true)
            .execute()
        ).map((f) => f.name),
      );
      let query = tx
        .selectFrom('cases')
        .select([
          'id',
          'external_id',
          'questionnaire_id',
          'sample',
          'status',
          'disposition',
          'assigned_to',
          'assigned_at',
          'attempts',
          'created_at',
          'updated_at',
        ])
        .where('project_id', '=', projectId)
        .orderBy(idOrder)
        .top(q.limit + 1);
      if (q.status) query = query.where('status', '=', q.status);
      if (after) query = query.where(sql<boolean>`CAST(id AS char(36)) > ${after.id}`);
      const rows = await query.execute();
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((c) => ({
          id: c.id.toLowerCase(),
          externalId: c.external_id,
          questionnaireId: c.questionnaire_id ? c.questionnaire_id.toLowerCase() : null,
          sample: maskSample(json<Record<string, unknown>>(c.sample, {}), pii, false),
          status: c.status,
          disposition: c.disposition,
          assignedTo: c.assigned_to ? c.assigned_to.toLowerCase() : null,
          assignedAt: c.assigned_at ? new Date(c.assigned_at as never).toISOString() : null,
          attempts: c.attempts,
          createdAt: new Date(c.created_at as never).toISOString(),
          updatedAt: new Date(c.updated_at as never).toISOString(),
        })),
        next: rows.length > q.limit ? encode({ id: page.at(-1)!.id.toLowerCase() }) : null,
      };
    });
  }

  /** Interviews of a project, oldest start first; metadata only, no answers. */
  @Get('projects/:projectId/interviews')
  @RequireScope('interviews:read')
  interviews(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(
      new ZodPipe(
        Page.extend({ status: z.string().max(40).optional(), since: z.coerce.date().optional() }),
      ),
    )
    q: z.infer<typeof Page> & { status?: string; since?: Date },
  ) {
    const after = decode(q.after, isAtCursor);
    return this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      await this.project(tx, ctx, projectId);
      let query = tx
        .selectFrom('interviews')
        .select([
          'id',
          'case_id',
          'questionnaire_version_id',
          'mode',
          'status',
          'disposition',
          'language',
          'started_at',
          'submitted_at',
          'active_ms',
          'sampled',
        ])
        .where('project_id', '=', projectId)
        .orderBy('started_at')
        .orderBy(idOrder)
        .top(q.limit + 1);
      if (q.status) query = query.where('status', '=', q.status);
      if (q.since) query = query.where('started_at', '>=', instant(q.since));
      if (after)
        query = query.where((eb) =>
          eb.or([
            eb('started_at', '>', instant(new Date(after.at))),
            eb.and([
              eb('started_at', '=', instant(new Date(after.at))),
              sql<boolean>`CAST(id AS char(36)) > ${after.id}`,
            ]),
          ]),
        );
      const rows = await query.execute();
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: page.map((i) => ({
          id: i.id.toLowerCase(),
          caseId: i.case_id ? i.case_id.toLowerCase() : null,
          questionnaireVersionId: i.questionnaire_version_id.toLowerCase(),
          mode: i.mode,
          status: i.status,
          disposition: i.disposition,
          language: i.language,
          startedAt: new Date(i.started_at as never).toISOString(),
          submittedAt: i.submitted_at ? new Date(i.submitted_at as never).toISOString() : null,
          activeMs: i.active_ms,
          sampled: !!i.sampled,
        })),
        next:
          rows.length > q.limit && last
            ? encode({
                at: new Date(last.started_at as never).toISOString(),
                id: last.id.toLowerCase(),
              })
            : null,
      };
    });
  }

  /** The activity log (audit:read), newest first. */
  @Get('audit-log')
  @RequireScope('audit:read')
  async auditLog(
    @Auth() ctx: AuthContext,
    @Query(
      new ZodPipe(
        z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          action: z.string().max(64).optional(),
        }),
      ),
    )
    q: { limit: number; action?: string },
  ) {
    // The log holds people's e-mail addresses and addresses: a key restricted to a project
    // does not read the organisation's log.
    if (ctx.apiKey!.projectId)
      throw new ForbiddenException({
        code: 'PROJECT_KEY',
        message: 'A key restricted to a project cannot read the organisation’s log',
      });
    const rows = await this.audit.list(ctx, q);
    return { data: rows.map((r) => ({ ...r, at: r.at.toISOString() })) };
  }
}
