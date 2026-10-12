import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, Public, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { setSessionCookies } from '../common/cookies.js';
import { encryptField } from '../common/crypto.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, loadConfig, type AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { tenantSso } from '../db/schema.js';
import type { ClientInfo } from './auth.service.js';
import { SsoError, SsoService } from './sso.service.js';

export const SSO_STATE_COOKIE = 'ws_sso';
const SSO_COOKIE_PATH = '/api/v1/auth/sso';

const StartQuery = z.object({
  org: z.string().min(1).max(64).optional(),
  email: z.string().email().max(254).optional(),
  returnTo: z.string().max(512).optional(),
});
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(256).optional(),
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SsoSettings = z
  .object({
    entraTenantId: z.string().regex(GUID, 'Directory (tenant) ID from the Entra app registration'),
    clientId: z.string().regex(GUID, 'Application (client) ID from the Entra app registration'),
    /** Omit to keep the stored secret. */
    clientSecret: z.string().min(1).max(512).optional(),
    enabled: z.boolean(),
    enforceSso: z.boolean().default(false),
    allowedDomains: z
      .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'A domain such as agency.org'))
      .max(50)
      .default([]),
  })
  .refine((s) => !s.enforceSso || s.enabled, {
    message: 'Enable Microsoft sign-in before requiring it',
    path: ['enforceSso'],
  })
  .refine((s) => !s.enabled || s.allowedDomains.length > 0, {
    message: 'List at least one e-mail domain whose people may sign in',
    path: ['allowedDomains'],
  });

const ssoLimit = { default: { limit: () => loadConfig().LOGIN_RATE_LIMIT * 3, ttl: 60_000 } };

function client(req: Request): ClientInfo {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

/** Browser-facing Microsoft sign-in. Both endpoints answer with redirects, never JSON. */
@ApiTags('auth')
@Controller('auth/sso')
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private stateCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const, // sent on Microsoft's top-level redirect back to us
      secure: this.config.NODE_ENV === 'production',
      path: SSO_COOKIE_PATH,
    };
  }

  private failRedirect(res: Response, code: string) {
    res.clearCookie(SSO_STATE_COOKIE, { path: SSO_COOKIE_PATH });
    res.redirect(302, `${this.config.PUBLIC_WEB_URL}/login?sso_error=${encodeURIComponent(code)}`);
  }

  /** `?org=<slug>` or `?email=<address>` (organisation found from the e-mail domain). */
  @Public()
  @Throttle(ssoLimit)
  @Get('start')
  async start(@Query(new ZodPipe(StartQuery)) q: z.infer<typeof StartQuery>, @Res() res: Response) {
    try {
      const { url, cookie } = await this.sso.start(q);
      res.cookie(SSO_STATE_COOKIE, cookie, { ...this.stateCookieOptions(), maxAge: 10 * 60_000 });
      res.redirect(302, url);
    } catch (e) {
      if (e instanceof SsoError) return this.failRedirect(res, e.code);
      throw e;
    }
  }

  @Public()
  @Throttle(ssoLimit)
  @Get('callback')
  async callback(
    @Query(new ZodPipe(CallbackQuery)) q: z.infer<typeof CallbackQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let tenantId: string | null = null;
    try {
      const st = this.sso.readState(req.cookies?.[SSO_STATE_COOKIE], q.state);
      tenantId = st.tenantId;
      if (q.error || !q.code)
        throw new SsoError(q.error ? 'microsoft_error' : 'missing_code', st.tenantId);
      const result = await this.sso.callback(st, q.code, client(req));
      res.clearCookie(SSO_STATE_COOKIE, { path: SSO_COOKIE_PATH });
      setSessionCookies(res, this.config, result.cookie, result.csrfToken);
      res.redirect(302, `${this.config.PUBLIC_WEB_URL}${result.returnTo}`);
    } catch (e) {
      if (!(e instanceof SsoError)) throw e;
      await this.sso.recordFailure(e.tenantId ?? tenantId, e.code, client(req));
      this.failRedirect(res, e.code);
    }
  }
}

/** Organisation settings for Microsoft sign-in. The client secret is write-only. */
@ApiTags('tenant')
@Controller('tenant/sso')
export class SsoSettingsController {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly sso: SsoService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('tenant.manage')
  get(@Auth() ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx.select().from(tenantSso).where(eq(tenantSso.tenantId, ctx.tenantId));
      return this.present(row ?? null);
    });
  }

  @Put()
  @RequirePermission('tenant.manage')
  @ApiBody({ schema: z.toJSONSchema(SsoSettings, { io: 'input' }) as object })
  put(@Auth() ctx: AuthContext, @Body(new ZodPipe(SsoSettings)) body: z.infer<typeof SsoSettings>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(tenantSso)
        .where(eq(tenantSso.tenantId, ctx.tenantId));
      const secretEnc = body.clientSecret
        ? encryptField(body.clientSecret, this.config.APP_ENCRYPTION_KEY)
        : (current?.clientSecretEnc ?? null);
      if (body.enabled && !secretEnc) {
        throw new BadRequestException('Add the client secret from the Entra app registration');
      }
      const values = {
        entraTenantId: body.entraTenantId.toLowerCase(),
        clientId: body.clientId.toLowerCase(),
        clientSecretEnc: secretEnc,
        enabled: body.enabled,
        enforceSso: body.enforceSso,
        allowedDomains: [...new Set(body.allowedDomains.map((d) => d.toLowerCase()))],
        updatedAt: new Date(),
      };
      const [row] = await tx
        .insert(tenantSso)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: tenantSso.tenantId, set: values })
        .returning();
      const { clientSecret: _secret, ...audited } = body;
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'tenant.sso_updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: { ...audited, clientSecretChanged: !!body.clientSecret },
        }),
      );
      return this.present(row!);
    });
  }

  private present(row: typeof tenantSso.$inferSelect | null) {
    return {
      configured: !!row,
      entraTenantId: row?.entraTenantId ?? null,
      clientId: row?.clientId ?? null,
      hasClientSecret: !!row?.clientSecretEnc,
      enabled: row?.enabled ?? false,
      enforceSso: row?.enforceSso ?? false,
      allowedDomains: row?.allowedDomains ?? [],
      /** Register this exact URL as a Web redirect URI in the Entra app registration. */
      redirectUri: this.sso.redirectUri,
    };
  }
}
