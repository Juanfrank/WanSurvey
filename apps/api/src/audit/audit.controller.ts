import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { csvEncoder, type Column } from '@wansurvey/exporters';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { AuditService } from './audit.service.js';

/** Filters the screen and the export share. */
const Filters = {
  action: z.string().max(64).optional(),
  /** Any of these actions, separated by commas (a preset such as corrections or exports). */
  actions: z
    .string()
    .max(2000)
    .transform((s) =>
      s
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().max(64)).max(50))
    .optional(),
  actorUserId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  /** A case's id or external id (as the project knows it, e.g. HH0004). */
  caseRef: z.string().trim().min(1).max(128).optional(),
};

const AuditQuery = z
  .object({
    ...Filters,
    targetId: z.string().max(64).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    /** The last entry of the previous page: the next page is what came before it. */
    beforeAt: z.coerce.date().optional(),
    beforeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((q) => !q.beforeAt === !q.beforeId, {
    message: '"beforeAt" and "beforeId" go together',
  });

const DAY = 86_400_000;
const AuditExportQuery = z.object({
  ...Filters,
  from: z.coerce.date(),
  to: z.coerce.date(),
  format: z.enum(['csv', 'jsonl']).default('csv'),
});

const COLUMNS: Column[] = [
  'at',
  'id',
  'actor_user_id',
  'action',
  'target_type',
  'target_id',
  'ip',
  'user_agent',
  'details',
].map((name) => ({ name, label: name, type: 'string' }) as Column);

@ApiTags('audit')
@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.read')
  list(
    @Auth() ctx: AuthContext,
    @Query(new ZodPipe(AuditQuery)) query: z.infer<typeof AuditQuery>,
  ) {
    const { beforeAt, beforeId, ...filter } = query;
    return this.audit.list(ctx, {
      ...filter,
      ...(beforeAt && beforeId ? { before: { at: beforeAt, id: beforeId } } : {}),
    });
  }

  /** The activity log of a range as a file, for an auditor; the export is itself logged. */
  @Get('export')
  @RequirePermission('audit.export')
  async export(
    @Auth() ctx: AuthContext,
    @Query(new ZodPipe(AuditExportQuery)) q: z.infer<typeof AuditExportQuery>,
    @Res() res: Response,
  ) {
    if (q.to < q.from) throw new BadRequestException('"to" is before "from"');
    if (q.to.getTime() - q.from.getTime() > 366 * DAY)
      throw new BadRequestException('The range is longer than 366 days');
    const filter = {
      from: q.from,
      to: q.to,
      action: q.action,
      actions: q.actions,
      actorUserId: q.actorUserId,
      projectId: q.projectId,
      caseRef: q.caseRef,
    };
    const logged = {
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      action: q.action ?? null,
      ...(q.actions?.length ? { actions: q.actions } : {}),
      actor: q.actorUserId ?? null,
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.caseRef ? { caseRef: q.caseRef } : {}),
      format: q.format,
    };
    await this.audit.record(ctx, {
      action: 'audit.exported',
      details: { ...logged, phase: 'started' },
    });
    const csv = csvEncoder(COLUMNS);
    const enc = new TextEncoder();
    res.setHeader(
      'Content-Type',
      q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="audit-log.${q.format}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const write = async (chunk: Uint8Array) => {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    };
    let rows = 0;
    try {
      if (q.format === 'csv') await write(csv.head());
      for await (const page of this.audit.exportPages(ctx, filter)) {
        rows += page.length;
        if (q.format === 'csv')
          await write(
            csv.rows(
              page.map((r) => [
                r.at.toISOString(),
                r.id,
                r.actorUserId ?? '',
                r.action,
                r.targetType ?? '',
                r.targetId ?? '',
                r.ip ?? '',
                r.userAgent ?? '',
                JSON.stringify(r.details),
              ]),
            ),
          );
        else
          await write(
            enc.encode(
              page.map((r) => JSON.stringify({ ...r, at: r.at.toISOString() }) + '\n').join(''),
            ),
          );
      }
      await this.audit.record(ctx, {
        action: 'audit.exported',
        details: { ...logged, phase: 'completed', rows },
      });
      res.end();
    } catch (err) {
      res.destroy(err as Error);
    }
  }
}
