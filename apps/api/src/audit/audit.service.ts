import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../common/auth-context.js';
import { Database, type Tx } from '../db/database.js';
import { auditLog } from '../db/schema.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.mfa_enabled'
  | 'auth.mfa_verified'
  | 'auth.mfa_failed'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'user.invited'
  | 'user.invitation_accepted'
  | 'user.role_changed'
  | 'user.deactivated'
  | 'user.forced_logout'
  | 'tenant.updated'
  | 'project.created'
  | 'project.updated'
  | 'audit.viewed';

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: Database) {}

  /** Appends an entry inside the caller's tenant transaction so it commits with the change. */
  async record(tx: Tx, tenantId: string, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      tenantId,
      action: entry.action,
      actorUserId: entry.actorUserId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details ?? {},
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  fromContext(
    ctx: AuthContext,
    entry: Omit<AuditEntry, 'actorUserId' | 'ip' | 'userAgent'>,
  ): AuditEntry {
    return { ...entry, actorUserId: ctx.userId, ip: ctx.ip, userAgent: ctx.userAgent };
  }

  async list(
    ctx: AuthContext,
    filter: {
      action?: string;
      actorUserId?: string;
      targetId?: string;
      from?: Date;
      to?: Date;
      limit: number;
    },
  ) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const conds: SQL[] = [];
      if (filter.action) conds.push(eq(auditLog.action, filter.action));
      if (filter.actorUserId) conds.push(eq(auditLog.actorUserId, filter.actorUserId));
      if (filter.targetId) conds.push(eq(auditLog.targetId, filter.targetId));
      if (filter.from) conds.push(gte(auditLog.at, filter.from));
      if (filter.to) conds.push(lte(auditLog.at, filter.to));
      return tx
        .select()
        .from(auditLog)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(auditLog.at), desc(auditLog.id))
        .limit(filter.limit);
    });
  }
}
