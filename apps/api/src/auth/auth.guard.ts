import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleMatrix, type Permission, type Role } from '@wansurvey/schema';
import { and, eq, isNull } from 'drizzle-orm';
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
import { Database, isUuid } from '../db/database.js';
import { memberships, sessions, tenantMembers, tenants, users } from '../db/schema.js';

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
    private readonly database: Database,
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

    const auth = await this.database.withTenant(cookie.tenantId, async (tx) => {
      const [row] = await tx
        .select({
          session: sessions,
          user: { id: users.id, email: users.email, status: users.status },
          memberStatus: tenantMembers.status,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(tenantMembers, eq(tenantMembers.userId, sessions.userId))
        .where(and(eq(sessions.tokenHash, sha256Hex(cookie.token)), isNull(sessions.revokedAt)))
        .limit(1);
      if (!row) return null;
      const { session, user, memberStatus } = row;
      // The account must be active, and still an active member of this organisation.
      if (
        user.status !== 'active' ||
        memberStatus !== 'active' ||
        session.expiresAt <= now ||
        now.getTime() - session.lastSeenAt.getTime() > idleMs
      ) {
        await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id));
        return null;
      }
      if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
      }
      const grants = await tx
        .select({ role: memberships.role, projectId: memberships.projectId })
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      // What each role may do here, with the organisation's changes.
      const [tenant] = await tx
        .select({ rolePermissions: tenants.rolePermissions })
        .from(tenants)
        .where(eq(tenants.id, cookie.tenantId));
      const matrix = roleMatrix(tenant?.rolePermissions);
      return {
        tenantId: cookie.tenantId,
        userId: user.id,
        sessionId: session.id,
        email: user.email,
        memberships: grants
          // A role this version no longer knows grants nothing.
          .filter((g) => g.role in matrix)
          .map((g) => ({
            role: g.role as Role,
            projectId: g.projectId,
            permissions: matrix[g.role as Role],
          })),
        mfaState: session.mfaState as AuthContext['mfaState'],
        authMethod: session.authMethod as AuthContext['authMethod'],
        idpTenant: session.idpTenant,
        csrfToken: session.csrfToken,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      } satisfies AuthContext;
    });
    if (!auth)
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Your session has ended; sign in again',
      });
    return auth;
  }
}
