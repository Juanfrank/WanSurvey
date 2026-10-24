import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { roleHasPermission, ROLE_RANK, type Permission, type Role } from '@wansurvey/schema';
import type { Request } from 'express';

export interface MembershipGrant {
  role: Role;
  /** null = tenant-wide. */
  projectId: string | null;
  /** What the role allows in this organisation (its matrix); the default matrix when absent. */
  permissions?: readonly Permission[];
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
  authMethod: 'password' | 'sso';
  /** Entra tenant that authenticated an SSO session. */
  idpTenant: string | null;
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
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
      (m.projectId === null ||
        projectId === 'any' ||
        (projectId != null && m.projectId === projectId)),
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
export const ALLOW_PENDING_MFA = 'ws:allowPendingMfa';
export const REQUIRED_PERMISSION = 'ws:permission';

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
