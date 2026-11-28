import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import {
  grantReaches,
  roleHasPermission,
  ROLE_RANK,
  type ApiKeyScope,
  type Permission,
  type Role,
} from '@wansurvey/schema';
import type { Request } from 'express';

export interface MembershipGrant {
  role: Role;
  /** null = tenant-wide. */
  projectId: string | null;
  /** What the role allows in this organisation (its matrix); the default matrix when absent. */
  permissions?: readonly Permission[];
  /** Closed projects this organisation-wide grant no longer reaches (a field role's). */
  exceptProjects?: readonly string[];
}

/** A WanSurvey code entered in this browser, or MFA performed by Microsoft. */
export type MfaMethod = 'totp' | 'entra';

export interface AuthContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  email: string;
  memberships: MembershipGrant[];
  mfaState: 'ok' | 'pending' | 'enroll';
  /** How the second factor was verified; null when none was ('ok' may mean none was needed). */
  mfaMethod: MfaMethod | null;
  authMethod: 'password' | 'sso' | 'apikey';
  /** Entra tenant that authenticated an SSO session. */
  idpTenant: string | null;
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
  /** Set when a key of the integration API made the request (no person, no session). */
  apiKey?: { id: string; scopes: ApiKeyScope[]; projectId: string | null };
  /**
   * The organisation's closed or archived projects, each with when it was closed (`null` when
   * that is not known). Fieldwork is over in them; field roles no longer reach them.
   */
  closedProjects?: ReadonlyMap<string, Date | null>;
  /**
   * Every grant as the person holds it, closed projects included (`memberships` leaves those
   * out): only for sending back work started before the project was closed.
   */
  heldGrants?: MembershipGrant[];
}

export type AuthedRequest = Request & { auth?: AuthContext };

/**
 * A permission holds tenant-wide when a tenant-wide membership grants it, and inside one project
 * when a tenant-wide or that project's membership grants it.
 */
export function can(
  memberships: MembershipGrant[],
  permission: Permission,
  projectId?: string | null | 'any',
): boolean {
  return memberships.some(
    (m) =>
      (m.permissions
        ? m.permissions.includes(permission)
        : roleHasPermission(m.role, permission)) &&
      (projectId === 'any' || grantReaches(m, projectId ?? null)),
  );
}

/** When the project was closed, if it is closed or archived (`null`: closed, time unknown). */
export function closedAt(ctx: AuthContext, projectId: string): Date | null | undefined {
  return ctx.closedProjects?.get(projectId.toLowerCase());
}

/** Whether fieldwork is over in the project (closed or archived). */
export const isClosed = (ctx: AuthContext, projectId: string): boolean =>
  closedAt(ctx, projectId) !== undefined;

/**
 * Whether work started at `startedAt` may still be sent to a closed project: it was started
 * before the project closed, by someone whose role there allowed it then (`heldGrants`).
 */
export function lateUploadAllowed(
  ctx: AuthContext,
  projectId: string,
  startedAt: Date,
  permissions: readonly Permission[],
): boolean {
  const at = closedAt(ctx, projectId);
  if (at === undefined) return false;
  const grants = ctx.heldGrants ?? ctx.memberships;
  return (
    at !== null &&
    startedAt.getTime() < at.getTime() &&
    permissions.some((p) => can(grants, p, projectId))
  );
}

/** Highest tenant-wide rank; used to stop users granting roles above their own. */
export function tenantRank(memberships: MembershipGrant[]): number {
  return Math.max(
    0,
    ...memberships.filter((m) => m.projectId === null).map((m) => ROLE_RANK[m.role]),
  );
}

export const IS_PUBLIC = 'ws:public';
export const EXT_API = 'ws:ext';
export const EXT_SCOPE = 'ws:ext-scope';
export const ALLOW_PENDING_MFA = 'ws:allowPendingMfa';
export const REQUIRED_PERMISSION = 'ws:permission';
export const FIELDWORK = 'ws:fieldwork';
export const AFTER_CLOSE = 'ws:afterClose';

/** The integration API: authenticated by an API key (bearer), never by a session or cookie. */
export const ExtApi = () => SetMetadata(EXT_API, true);
/** The scope a key needs for this route. */
export const RequireScope = (scope: ApiKeyScope) => SetMetadata(EXT_SCOPE, scope);

/**
 * Fieldwork in the project of the route (`projectParam`): refused with 409 `PROJECT_CLOSED` once
 * the project is closed or archived, whoever asks.
 */
export const FieldWork = () => SetMetadata(FIELDWORK, true);
/**
 * Reachable with the roles held before the project closed: a device sends back what it did
 * before the close (the handler decides what is still taken, see `lateUploadAllowed`).
 */
export const AfterClose = () => SetMetadata(AFTER_CLOSE, true);

/** No session needed (login, password reset, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Reachable before TOTP is verified or enrolled (2FA setup, logout, me). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);

export interface PermissionRequirement {
  /** One permission, or several of which any one is enough. */
  permission: Permission | readonly Permission[];
  /** Route param holding the project id the permission is checked against. */
  projectParam?: string;
  /** Granted by a membership in any project (the handler then filters to those projects). */
  anyProject?: boolean;
}

export const RequirePermission = (
  permission: Permission | readonly Permission[],
  opts: { projectParam?: string; anyProject?: boolean } = {},
) => SetMetadata(REQUIRED_PERMISSION, { permission, ...opts } satisfies PermissionRequirement);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('Auth context missing on a protected route');
  return req.auth;
});
