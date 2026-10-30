import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@wansurvey/schema';
import {
  ALLOW_PENDING_MFA,
  can,
  IS_PUBLIC,
  REQUIRED_PERMISSION,
  type AuthContext,
  type AuthedRequest,
  type PermissionRequirement,
} from '../common/auth-context.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../common/cookies.js';
import { safeEqual, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { isUuid } from '../db/database.js';
import { AUTH_REPO, grantsOf, type AuthRepo } from './auth-repo.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOUCH_INTERVAL_MS = 60_000;

/** Parses `<tenantId>.<token>` from the session cookie. */
export function parseSessionCookie(value: unknown): { tenantId: string; token: string } | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  const tenantId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (dot < 0 || !isUuid(tenantId) || token.length < 20) return null;
  return { tenantId, token };
}

/**
 * Global guard, in order: session (cookie) → idle/absolute expiry → MFA state → CSRF on
 * state-changing requests → permission (tenant-wide or project-scoped). Every endpoint is
 * protected unless marked @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_REPO) private readonly repo: AuthRepo,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = await this.loadSession(req);
    req.auth = auth;

    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, targets);
    if (auth.mfaState !== 'ok' && !allowPending) {
      throw new ForbiddenException({
        code: auth.mfaState === 'enroll' ? 'MFA_ENROLLMENT_REQUIRED' : 'MFA_REQUIRED',
        message:
          auth.mfaState === 'enroll'
            ? 'Set up two-factor authentication to continue'
            : 'Enter your authentication code',
      });
    }

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, auth.csrfToken)) {
        throw new ForbiddenException({ code: 'CSRF', message: 'Missing or invalid CSRF token' });
      }
    }

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRED_PERMISSION,
      targets,
    );
    if (requirement) {
      const param = requirement.projectParam ? req.params[requirement.projectParam] : undefined;
      const projectId = typeof param === 'string' ? param : undefined;
      if (requirement.projectParam && !isUuid(projectId)) throw new ForbiddenException('Forbidden');
      const wanted: readonly Permission[] = Array.isArray(requirement.permission)
        ? requirement.permission
        : [requirement.permission as Permission];
      const scope = requirement.anyProject ? 'any' : (projectId ?? null);
      if (!wanted.some((p) => can(auth.memberships, p, scope))) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You do not have permission to do this',
        });
      }
    }
    return true;
  }

  private async loadSession(req: AuthedRequest): Promise<AuthContext> {
    const cookie = parseSessionCookie(req.cookies?.[SESSION_COOKIE]);
    if (!cookie)
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in required' });
    const now = new Date();
    const idleMs = this.config.SESSION_IDLE_MINUTES * 60_000;

    const session = await this.repo.session(
      cookie.tenantId,
      sha256Hex(cookie.token),
      now,
      idleMs,
      TOUCH_INTERVAL_MS,
    );
    const auth: AuthContext | null = session && {
      tenantId: cookie.tenantId,
      userId: session.userId,
      sessionId: session.id,
      email: session.email,
      memberships: grantsOf(session),
      mfaState: session.mfaState as AuthContext['mfaState'],
      mfaMethod: session.mfaMethod as AuthContext['mfaMethod'],
      authMethod: session.authMethod as AuthContext['authMethod'],
      idpTenant: session.idpTenant,
      csrfToken: session.csrfToken,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };
    if (!auth)
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Your session has ended; sign in again',
      });
    return auth;
  }
}
