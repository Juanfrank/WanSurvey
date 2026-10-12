import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { tenants } from '../db/schema.js';

const TenantPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
});

@ApiTags('tenant')
@Controller('tenant')
export class TenantsController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('tenant.read')
  get(@Auth() ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
      return tenant;
    });
  }

  @Patch()
  @RequirePermission('tenant.manage')
  @ApiBody({ schema: z.toJSONSchema(TenantPatch) as object })
  update(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(TenantPatch)) body: z.infer<typeof TenantPatch>,
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [tenant] = await tx
        .update(tenants)
        .set(body)
        .where(eq(tenants.id, ctx.tenantId))
        .returning();
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'tenant.updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: body,
        }),
      );
      return tenant;
    });
  }
}
