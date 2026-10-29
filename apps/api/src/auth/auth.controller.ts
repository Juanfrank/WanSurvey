import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowPendingMfa, Auth, Public, type AuthContext } from '../common/auth-context.js';
import { clearSessionCookies, setSessionCookies } from '../common/cookies.js';
import { ZodPipe } from '../common/zod.js';
import { CONFIG, loadConfig, type AppConfig } from '../config.js';
import { AuthService, MIN_PASSWORD_LENGTH, type ClientInfo } from './auth.service.js';

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(512),
  /** Organisation slug or id; defaults to the one used last. */
  tenant: z.string().min(1).max(64).optional(),
});
const SwitchBody = z.object({ tenantId: z.string().uuid() });
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });
const Password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`)
  .max(512);
const TokenPasswordBody = z.object({ token: z.string().min(20).max(512), password: Password });
const ForgotBody = z.object({ email: z.string().email().max(254) });

const authLimit = { default: { limit: () => loadConfig().LOGIN_RATE_LIMIT, ttl: 60_000 } };

function client(req: Request): ClientInfo {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** With password sign-in off (PASSWORD_LOGIN=false), every password route answers this. */
  private passwordsOff() {
    if (this.config.PASSWORD_LOGIN) return;
    throw new ForbiddenException({
      code: 'PASSWORD_LOGIN_DISABLED',
      message: 'Sign in with Microsoft',
      ssoStartUrl: `${this.config.PUBLIC_WEB_URL}/api/v1/auth/sso/start`,
    });
  }

  /** What the sign-in page offers: the password form, and whether Microsoft needs the e-mail. */
  @Public()
  @Get('methods')
  methods() {
    return {
      password: this.config.PASSWORD_LOGIN,
      microsoftNeedsEmail: !this.config.SSO_DEFAULT_ORG,
    };
  }

  @Public()
  @Throttle(authLimit)
  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(LoginBody) as object })
  async login(
    @Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.passwordsOff();
    const result = await this.auth.login(body, client(req));
    setSessionCookies(res, this.config, result.cookie, result.csrfToken);
    return {
      mfaState: result.mfaState,
      csrfToken: result.csrfToken,
      tenant: result.tenant,
      tenants: result.tenants,
    };
  }

  @AllowPendingMfa()
  @Get('tenants')
  tenants(@Auth() ctx: AuthContext) {
    return this.auth.listTenants(ctx);
  }

  @Post('switch-tenant')
  @HttpCode(200)
  @ApiBody({ schema: z.toJSONSchema(SwitchBody) as object })
  async switchTenant(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(SwitchBody)) body: z.infer<typeof SwitchBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.switchTenant(ctx, body.tenantId, client(req));
    setSessionCookies(res, this.config, result.cookie, result.csrfToken);
    return { mfaState: result.mfaState, csrfToken: result.csrfToken, tenant: result.tenant };
  }

  @AllowPendingMfa()
  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() ctx: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx);
    clearSessionCookies(res);
  }

  @AllowPendingMfa()
  @Get('me')
  me(@Auth() ctx: AuthContext) {
    return this.auth.me(ctx);
  }

  @AllowPendingMfa()
  @Post('2fa/setup')
  @HttpCode(200)
  setup2fa(@Auth() ctx: AuthContext) {
    return this.auth.setupTotp(ctx);
  }

  @AllowPendingMfa()
  @Throttle(authLimit)
  @Post('2fa/enable')
  @HttpCode(204)
  async enable2fa(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(CodeBody)) body: z.infer<typeof CodeBody>,
  ) {
    await this.auth.enableTotp(ctx, body.code);
  }

  @AllowPendingMfa()
  @Throttle(authLimit)
  @Post('2fa/verify')
  @HttpCode(204)
  async verify2fa(
    @Auth() ctx: AuthContext,
    @Body(new ZodPipe(CodeBody)) body: z.infer<typeof CodeBody>,
  ) {
    await this.auth.verifyTotp(ctx, body.code);
  }

  @Public()
  @Throttle(authLimit)
  @Post('invitations/accept')
  @HttpCode(204)
  async acceptInvitation(
    @Body(new ZodPipe(TokenPasswordBody)) body: z.infer<typeof TokenPasswordBody>,
    @Req() req: Request,
  ) {
    this.passwordsOff();
    await this.auth.acceptInvitation(body, client(req));
  }

  @Public()
  @Throttle(authLimit)
  @Post('password/forgot')
  @HttpCode(204)
  async forgot(
    @Body(new ZodPipe(ForgotBody)) body: z.infer<typeof ForgotBody>,
    @Req() req: Request,
  ) {
    this.passwordsOff();
    await this.auth.forgotPassword(body, client(req));
  }

  @Public()
  @Throttle(authLimit)
  @Post('password/reset')
  @HttpCode(204)
  async reset(
    @Body(new ZodPipe(TokenPasswordBody)) body: z.infer<typeof TokenPasswordBody>,
    @Req() req: Request,
  ) {
    this.passwordsOff();
    await this.auth.resetPassword(body, client(req));
  }
}
