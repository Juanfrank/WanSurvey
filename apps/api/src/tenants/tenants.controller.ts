import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database } from '../db/database.js';
import { tenants } from '../db/schema.js';

/** Organisation-wide defaults; keys left out of a PATCH keep their value. */
export const TenantSettings = z
  .object({
    /** Language of new projects (BCP 47, e.g. es, en, es-PE). */
    defaultLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
    /** Time zone of new projects (IANA, e.g. America/Lima). */
    defaultTimezone: z
      .string()
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone'),
  })
  .partial()
  .strict();

const TenantPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  settings: TenantSettings.optional(),
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
      const [current] = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const [tenant] = await tx
        .update(tenants)
        .set({
          ...body,
          ...(body.settings
            ? { settings: { ...((current?.settings as object) ?? {}), ...body.settings } }
            : {}),
        })
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
