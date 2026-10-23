import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import {
  CUSTOM_ROLES,
  PERMISSIONS,
  RESERVED_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  roleMatrix,
  RoleOverrides,
  type Permission,
} from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { DisplayName, ZodPipe } from '../common/zod.js';
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
  name: DisplayName.optional(),
  settings: TenantSettings.optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
});

const RolesBody = z.object({ overrides: RoleOverrides });

const sameSet = (a: readonly Permission[], b: readonly Permission[]) =>
  a.length === b.length && a.every((p) => b.includes(p));

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

  /** What each role may do in this organisation, next to the defaults. */
  @Get('roles')
  @RequirePermission('tenant.read')
  roles(@Auth() ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ rolePermissions: tenants.rolePermissions })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const matrix = roleMatrix(tenant?.rolePermissions);
      return {
        roles: ROLES.map((role) => ({
          role,
          permissions: matrix[role],
          defaults: ROLE_PERMISSIONS[role],
          editable: (CUSTOM_ROLES as readonly string[]).includes(role),
          changed: !sameSet(matrix[role], ROLE_PERMISSIONS[role]),
        })),
        permissions: PERMISSIONS,
        reserved: RESERVED_PERMISSIONS,
      };
    });
  }

  /** Replaces the organisation's changes; a role left out goes back to its defaults. */
  @Put('roles')
  @RequirePermission('tenant.manage')
  @ApiBody({ schema: z.toJSONSchema(RolesBody, { io: 'input' }) as object })
  async setRoles(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(RolesBody)) body: z.infer<typeof RolesBody>,
  ) {
    // Only what differs from the defaults is kept, so later default changes still reach the rest.
    const matrix = roleMatrix(body.overrides);
    const kept = Object.fromEntries(
      CUSTOM_ROLES.filter((r) => !sameSet(matrix[r], ROLE_PERMISSIONS[r])).map((r) => [
        r,
        matrix[r],
      ]),
    );
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      const [current] = await tx
        .select({ rolePermissions: tenants.rolePermissions })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      await tx.update(tenants).set({ rolePermissions: kept }).where(eq(tenants.id, ctx.tenantId));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'tenant.roles_updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: { before: current?.rolePermissions ?? {}, after: kept },
        }),
      );
    });
    return this.roles(ctx);
  }
}
