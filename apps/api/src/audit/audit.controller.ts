import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { AuditService } from './audit.service.js';

const AuditQuery = z.object({
  action: z.string().max(64).optional(),
  actorUserId: z.string().uuid().optional(),
  targetId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

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
    return this.audit.list(ctx, query);
  }
}
