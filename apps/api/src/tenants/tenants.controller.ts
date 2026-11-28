import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Patch,
  PayloadTooLargeException,
  Put,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CUSTOM_ROLES,
  OrgTheme,
  checkTheme,
  FormatLocale,
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
import { ORG_REPO, type OrgRepo } from '../projects/org-repo.js';
import { LOGO_MAX, orgLogoType, sendLogo } from './org-logo.js';

/** What the organisation's logo shows, for people who cannot see it: always given. */
const LogoAlt = z.string().trim().min(1).max(200);

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
    // No `twoFactorRoles` any more: every password sign-in needs two-step verification.
  })
  .partial()
  .strict();

const TenantPatch = z.object({
  name: DisplayName.optional(),
  settings: TenantSettings.optional(),
  /** Merged into the stored branding; `theme` is the organisation's default and accent. */
  branding: z.object({ theme: OrgTheme }).partial().catchall(z.unknown()).optional(),
  /**
   * How dates, times and numbers are written (BCP 47, e.g. es-PE, en-GB): separators, the order
   * of day and month, 24 or 12 hours. Null goes back to following the language.
   */
  formatLocale: FormatLocale.nullable().optional(),
  /** The description of the organisation's logo (its alt text), once there is one. */
  logoAlt: LogoAlt.optional(),
});

const RolesBody = z.object({ overrides: RoleOverrides });

/** The theme's colours in lower case, as they are kept. */
function lowerColours(theme: OrgTheme): OrgTheme {
  return {
    ...theme,
    ...(theme.primary ? { primary: theme.primary.toLowerCase() } : {}),
    ...(theme.accentColor ? { accentColor: theme.accentColor.toLowerCase() } : {}),
    ...(theme.sidebar
      ? {
          sidebar: {
            background: theme.sidebar.background.toLowerCase(),
            text: theme.sidebar.text.toLowerCase(),
          },
        }
      : {}),
  };
}

const sameSet = (a: readonly Permission[], b: readonly Permission[]) =>
  a.length === b.length && a.every((p) => b.includes(p));

@ApiTags('tenant')
@Controller('tenant')
export class TenantsController {
  constructor(
    @Inject(ORG_REPO) private readonly repo: OrgRepo,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('tenant.read')
  get(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, (t) => t.tenant());
  }

  @Patch()
  @RequirePermission('tenant.manage')
  @ApiBody({ schema: z.toJSONSchema(TenantPatch, { io: 'input' }) as object })
  update(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(TenantPatch)) body: z.infer<typeof TenantPatch>,
  ) {
    // A theme is kept only if its text stays readable, in both themes (a main colour of the
    // organisation's own is darkened where needed instead: see `primaryFill`).
    const theme = body.branding?.theme;
    if (theme) {
      const failures = checkTheme(theme);
      if (failures.length)
        throw new BadRequestException({
          code: 'THEME_CONTRAST',
          message: 'Those colours do not keep the text readable',
          failures,
        });
      // Colours are kept as #rrggbb in lower case, whatever was typed.
      body.branding!.theme = lowerColours(theme);
    }
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const before = await t.tenant();
      if (body.logoAlt !== undefined && !before?.logo)
        throw new ConflictException({ code: 'NO_LOGO', message: 'Upload a logo first' });
      const current = body.branding ? (before?.branding ?? {}) : {};
      const tenant = await t.updateTenant({
        ...body,
        ...(body.branding ? { branding: { ...current, ...body.branding } } : {}),
      });
      await t.audit(
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

  /**
   * Uploads the organisation's logo with its description (multipart: `file` and `alt`),
   * replacing any other. PNG, JPEG or WebP up to 512 KB, recognised by its bytes; SVG is refused,
   * as it can carry scripts.
   */
  @Put('logo')
  @RequirePermission('tenant.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX } }))
  uploadLogo(
    @Auth() ctx: AuthContext,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Body() form: { alt?: unknown },
  ) {
    if (!file) throw new BadRequestException('Attach the image as "file"');
    if (file.size > LOGO_MAX) throw new PayloadTooLargeException();
    const alt = LogoAlt.safeParse(form?.alt);
    if (!alt.success)
      throw new BadRequestException({
        code: 'LOGO_ALT_REQUIRED',
        message: 'Describe the logo (its text alternative)',
      });
    const contentType = orgLogoType(file.buffer);
    if (!contentType)
      throw new UnprocessableEntityException({
        code: 'NOT_AN_IMAGE',
        message: 'Use a PNG, JPEG or WebP image',
      });
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const tenant = await t.setTenantLogo({ contentType, image: file.buffer, alt: alt.data });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'tenant.updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: { logo: contentType, size: file.size, logoAlt: alt.data },
        }),
      );
      return tenant;
    });
  }

  /** The organisation's logo, for everyone who works in it (the side panel shows it). */
  @Get('logo')
  async logo(@Auth() ctx: AuthContext, @Res() res: Response) {
    const logo = await this.repo.inTenant(ctx.tenantId, (t) => t.tenantLogo());
    if (!logo) throw new NotFoundException('No logo');
    sendLogo(res, logo, 'private');
  }

  @Delete('logo')
  @RequirePermission('tenant.manage')
  removeLogo(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const tenant = await t.removeTenantLogo();
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'tenant.updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: { logo: null },
        }),
      );
      return tenant;
    });
  }

  /** What each role may do in this organisation, next to the defaults. */
  @Get('roles')
  @RequirePermission('tenant.read')
  roles(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const tenant = await t.tenant();
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
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      const before = await t.setRolePermissions(kept);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'tenant.roles_updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: { before, after: kept },
        }),
      );
    });
    return this.roles(ctx);
  }
}
