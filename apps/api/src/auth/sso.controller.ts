import {
  BadRequestException,
  ConflictException,
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
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, Public, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { SESSION_COOKIE, setSessionCookies } from '../common/cookies.js';
import { encryptField } from '../common/crypto.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, loadConfig, type AppConfig } from '../config.js';
import { AUTH_REPO, type AuthRepo, type SsoRow } from './auth-repo.js';
import type { ClientInfo } from './auth.service.js';
import { SsoConfigs } from './sso-config.js';
import { SsoError, SsoService } from './sso.service.js';

export const SSO_STATE_COOKIE = 'ws_sso';
// Set by /api/v1/auth/sso/start, read by the callback (/api/auth/entra/callback): their common root.
const SSO_COOKIE_PATH = '/api';

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
    /** Not needed (ignored) when the deployment sets the directory (ENTRA_*). */
    entraTenantId: z
      .string()
      .regex(GUID, 'Directory (tenant) ID from the Entra app registration')
      .optional(),
    clientId: z
      .string()
      .regex(GUID, 'Application (client) ID from the Entra app registration')
      .optional(),
    /** Omit to keep the stored secret. */
    clientSecret: z.string().min(1).max(512).optional(),
    enabled: z.boolean(),
    enforceSso: z.boolean().default(false),
    /** Omit to keep the stored choice (a new organisation: true). */
    autoProvision: z.boolean().optional(),
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

/** What both addresses of the callback do. */
abstract class SsoCallbackBase {
  constructor(
    protected readonly sso: SsoService,
    @Inject(CONFIG) protected readonly config: AppConfig,
  ) {}

  protected failRedirect(res: Response, code: string) {
    res.clearCookie(SSO_STATE_COOKIE, { path: SSO_COOKIE_PATH });
    res.redirect(302, `${this.config.PUBLIC_URL}/login?sso_error=${encodeURIComponent(code)}`);
  }

  protected async finish(q: z.infer<typeof CallbackQuery>, req: Request, res: Response) {
    let tenantId: string | null = null;
    try {
      const st = this.sso.readState(req.cookies?.[SSO_STATE_COOKIE], q.state);
      tenantId = st.tenantId;
      if (q.error || !q.code)
        throw new SsoError(q.error ? 'microsoft_error' : 'missing_code', st.tenantId);
      const result = await this.sso.callback(st, q.code, client(req), () =>
        this.sso.signedInUser(req.cookies?.[SESSION_COOKIE]),
      );
      res.clearCookie(SSO_STATE_COOKIE, { path: SSO_COOKIE_PATH });
      setSessionCookies(res, this.config, result.cookie, result.csrfToken);
      res.redirect(302, `${this.config.PUBLIC_URL}${result.returnTo}`);
    } catch (e) {
      if (!(e instanceof SsoError)) throw e;
      await this.sso.recordFailure(e.tenantId ?? tenantId, e.code, client(req));
      this.failRedirect(res, e.code);
    }
  }
}

/** Browser-facing Microsoft sign-in: where it starts. */
@ApiTags('auth')
@Controller('auth/sso')
export class SsoController extends SsoCallbackBase {
  private stateCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const, // sent on Microsoft's top-level redirect back to us
      secure: this.config.NODE_ENV === 'production',
      path: SSO_COOKIE_PATH,
    };
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
}

/** Where Microsoft sends the person back (ENTRA_REDIRECT_URI): the same address in every app. */
@ApiTags('auth')
@Controller('api/auth/entra')
export class EntraCallbackController extends SsoCallbackBase {
  @Public()
  @Throttle(ssoLimit)
  @Get('callback')
  callback(
    @Query(new ZodPipe(CallbackQuery)) q: z.infer<typeof CallbackQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.finish(q, req, res);
  }
}

/** Organisation settings for Microsoft sign-in. The client secret is write-only. */
@ApiTags('tenant')
@Controller('tenant/sso')
export class SsoSettingsController {
  constructor(
    @Inject(AUTH_REPO) private readonly repo: AuthRepo,
    private readonly audit: AuditService,
    private readonly sso: SsoService,
    private readonly configs: SsoConfigs,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('tenant.manage')
  async get(@Auth() ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, async (t) => this.present(await t.ssoSettings()));
  }

  @Put()
  @RequirePermission('tenant.manage')
  @ApiBody({ schema: z.toJSONSchema(SsoSettings, { io: 'input' }) as object })
  async put(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(SsoSettings)) body: z.infer<typeof SsoSettings>,
  ) {
    // With the deployment's directory (ENTRA_*) the organisation keeps what is its own: on or off,
    // its domains, whether Microsoft is required; the directory and secret saved with them are the
    // deployment's.
    const directory = this.configs.deploymentDirectory();
    const entraTenantId = directory?.entraTenantId ?? body.entraTenantId;
    const clientId = directory?.clientId ?? body.clientId;
    if (!entraTenantId || !clientId)
      throw new BadRequestException(
        'Add the directory (tenant) ID and the application (client) ID',
      );
    // A domain belongs to one organisation: two would make e-mail sign-in ambiguous, and one
    // could claim another's addresses.
    const domains = [...new Set(body.allowedDomains.map((d) => d.toLowerCase()))];
    const taken = (domain: string) =>
      new ConflictException({
        code: 'DOMAIN_TAKEN',
        message: `The domain ${domain} is already used by another organisation`,
      });
    const outside = directory?.allowedDomains.length
      ? domains.filter((d) => !directory.allowedDomains.includes(d))
      : [];
    if (outside.length)
      throw new BadRequestException({
        code: 'DOMAIN_NOT_ALLOWED',
        message: `The deployment's directory does not serve: ${outside.join(', ')}`,
      });
    const saved = await this.repo.inTenant(ctx.tenantId, async (t) => {
      // One organisation saves its domains at a time, and checks them once the saves before it
      // have committed: two saving the same domain at once cannot both get it.
      await t.lockSsoDomains();
      for (const domain of domains) {
        const owners = await t.ssoDomainOwners(domain);
        if (owners.some((id) => id !== ctx.tenantId)) throw taken(domain);
      }
      const current = await t.ssoSettings();
      const secretEnc = directory
        ? null
        : body.clientSecret
          ? encryptField(body.clientSecret, this.config.ENCRYPTION_KEY)
          : (current?.clientSecretEnc ?? null);
      if (body.enabled && !directory && !secretEnc) {
        throw new BadRequestException('Add the client secret from the Entra app registration');
      }
      const row = await t.saveSso({
        entraTenantId: entraTenantId.toLowerCase(),
        clientId: clientId.toLowerCase(),
        clientSecretEnc: secretEnc,
        enabled: body.enabled,
        enforceSso: body.enforceSso,
        autoProvision: body.autoProvision ?? current?.autoProvision ?? true,
        allowedDomains: domains,
      });
      const { clientSecret: _secret, ...audited } = body;
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'tenant.sso_updated',
          targetType: 'tenant',
          targetId: ctx.tenantId,
          details: { ...audited, clientSecretChanged: !!body.clientSecret },
        }),
      );
      return this.present(row);
    });
    // Once committed: every process reads the new settings on the next sign-in.
    await this.configs.changed(ctx.tenantId);
    return saved;
  }

  private present(row: SsoRow | null) {
    const directory = this.configs.deploymentDirectory();
    return {
      configured: !!row,
      /** The directory and its secret are the deployment's (ENTRA_*): shown, not edited. */
      managedByDeployment: !!directory,
      entraTenantId: directory?.entraTenantId ?? row?.entraTenantId ?? null,
      clientId: directory?.clientId ?? row?.clientId ?? null,
      hasClientSecret: !!directory || !!row?.clientSecretEnc,
      enabled: row?.enabled ?? false,
      enforceSso: row?.enforceSso ?? false,
      autoProvision: row?.autoProvision ?? true,
      /** ENTRA_AUTO_PROVISION=false: the deployment forbids it for every organisation. */
      autoProvisionAllowed: this.config.ENTRA_AUTO_PROVISION,
      allowedDomains: row?.allowedDomains ?? [],
      /** Domains the deployment's directory serves, when it limits them (empty: any). */
      deploymentDomains: directory?.allowedDomains ?? [],
      /** Register this exact URL as a Web redirect URI in the Entra app registration. */
      redirectUri: this.sso.redirectUri,
    };
  }
}
