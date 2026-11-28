import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiKeyScope, Permission } from '@wansurvey/schema';
import { ApiKeysService } from '../apikeys/api-keys.service.js';
import {
  AFTER_CLOSE,
  ALLOW_PENDING_MFA,
  can,
  FIELDWORK,
  EXT_API,
  EXT_SCOPE,
  IS_PUBLIC,
  isClosed,
  REQUIRED_PERMISSION,
  type AuthContext,
  type AuthedRequest,
  type PermissionRequirement,
} from '../common/auth-context.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../common/cookies.js';
import { safeEqual, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { AUTH_REPO, grantsOf, heldGrantsOf, type AuthRepo } from './auth-repo.js';
import { isUuid } from '../db/common.js';
import { Tenancy } from '../tenants/tenancy.js';

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
    private readonly keys: ApiKeysService,
    private readonly tenancy: Tenancy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    // The integration API: a bearer key and nothing else (no cookie, no CSRF, no person).
    if (this.reflector.getAllAndOverride<boolean>(EXT_API, targets)) {
      req.auth = await this.loadKey(
        req,
        this.reflector.get<ApiKeyScope>(EXT_SCOPE, context.getHandler()),
      );
      return true;
    }
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
      // Sending back work done before the project closed: with the roles held then.
      const afterClose = this.reflector.getAllAndOverride<boolean>(AFTER_CLOSE, targets);
      const grants = afterClose ? (auth.heldGrants ?? auth.memberships) : auth.memberships;
      if (!wanted.some((p) => can(grants, p, scope))) {
        // A field role in a project that has been closed: said as such, not as a missing role.
        const held = auth.heldGrants ?? [];
        if (projectId && isClosed(auth, projectId) && wanted.some((p) => can(held, p, projectId)))
          throw new ForbiddenException({
            code: 'PROJECT_CLOSED',
            message: 'This project is closed',
          });
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You do not have permission to do this',
        });
      }
      if (
        projectId &&
        this.reflector.getAllAndOverride<boolean>(FIELDWORK, targets) &&
        isClosed(auth, projectId)
      )
        throw new ConflictException({
          code: 'PROJECT_CLOSED',
          message: 'This project is closed: fieldwork is over',
        });
    }
    return true;
  }

  private async loadKey(req: AuthedRequest, scope: ApiKeyScope | undefined): Promise<AuthContext> {
    const key = await this.keys.authenticate(req.headers.authorization, req.ip ?? null);
    // Single-tenant mode: a key of another organisation in the database opens nothing.
    if (!(await this.tenancy.allows(key.tenantId)))
      throw new UnauthorizedException({ code: 'INVALID_API_KEY', message: 'Invalid API key' });
    if (scope && !key.scopes.includes(scope))
      throw new ForbiddenException({
        code: 'MISSING_SCOPE',
        message: `This key does not have the scope ${scope}`,
      });
    return {
      tenantId: key.tenantId,
      // Whatever the key writes (its audit entries) is attributed to the person who made it.
      userId: key.createdBy,
      sessionId: key.id,
      email: 'api-key',
      memberships: [],
      mfaState: 'ok',
      mfaMethod: null,
      authMethod: 'apikey',
      idpTenant: null,
      csrfToken: '',
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      apiKey: { id: key.id, scopes: key.scopes, projectId: key.projectId },
    };
  }

  private async loadSession(req: AuthedRequest): Promise<AuthContext> {
    const cookie = parseSessionCookie(req.cookies?.[SESSION_COOKIE]);
    if (!cookie)
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sign in required' });
    // Single-tenant mode: a session of another organisation in the database (from before the
    // mode was turned on) has ended.
    if (!(await this.tenancy.allows(cookie.tenantId)))
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Your session has ended; sign in again',
      });
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
      heldGrants: heldGrantsOf(session),
      closedProjects: new Map(
        (session.closedProjects ?? []).map((p) => [p.id.toLowerCase(), p.closedAt] as const),
      ),
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
