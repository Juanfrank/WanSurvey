import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../common/auth-context.js';
import { Engine } from '../db/engine.js';
import { AuditStore, type AuditFilter, type AuditRow } from './audit-store.mssql.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.tenant_switched'
  | 'auth.sso_failed'
  | 'user.provisioned_sso'
  | 'user.identity_linked'
  | 'tenant.sso_updated'
  | 'auth.mfa_enabled'
  | 'auth.mfa_verified'
  | 'auth.mfa_failed'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'user.invited'
  | 'user.invitation_accepted'
  | 'user.role_changed'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.invitation_resent'
  | 'user.forced_logout'
  | 'tenant.updated'
  | 'tenant.roles_updated'
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'project.created'
  | 'project.updated'
  | 'questionnaire.created'
  | 'questionnaire.renamed'
  | 'questionnaire.deleted'
  | 'questionnaire.disabled'
  | 'questionnaire.enabled'
  | 'questionnaire.completed'
  | 'sampling.selected'
  | 'sampling.reserves_released'
  | 'sampling.batch_added'
  | 'sampling.substituted'
  | 'questionnaire.draft_saved'
  | 'questionnaire.published'
  | 'questionnaire.version_retired'
  | 'questionnaire.scenario_saved'
  | 'questionnaire.scenario_deleted'
  | 'cases.import_uploaded'
  | 'cases.imported'
  | 'cases.assigned'
  | 'case.updated'
  | 'case.pii_viewed'
  | 'case.subject_exported'
  | 'case.anonymised'
  | 'cases.pii_sealed'
  | 'case.claimed'
  | 'case.released'
  | 'case.checkout_released'
  | 'cases.geocoded'
  | 'cases.map_viewed'
  | 'interview.submitted'
  | 'entry.resolved'
  | 'papi.scans_uploaded'
  | 'interview.reviewed'
  | 'interview.approved'
  | 'interview.returned'
  | 'interview.rejected'
  | 'interview.corrected'
  | 'data.exported'
  | 'data.downloaded'
  | 'share_link.created'
  | 'share_link.revoked'
  | 'library_item.created'
  | 'library_item.deleted'
  | 'sample_field.updated'
  | 'assignment.created'
  | 'assignment.updated'
  | 'assignment.deleted'
  | 'audit.exported'
  | 'apikey.created'
  | 'apikey.revoked';

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
  private readonly store = new AuditStore();

  constructor(private readonly engine: Engine) {}

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
    return this.engine.sql.withTenant(ctx.tenantId, (tx) => this.store.list(tx, filter));
  }

  /** Appends an entry inside the caller's own tenant transaction. */
  async recordIn(
    tx: Parameters<AuditStore['record']>[0],
    ctx: AuthContext,
    entry: Omit<AuditEntry, 'actorUserId' | 'ip' | 'userAgent'>,
  ) {
    await this.store.record(tx, ctx.tenantId, this.fromContext(ctx, entry));
  }

  async record(ctx: AuthContext, entry: Omit<AuditEntry, 'actorUserId' | 'ip' | 'userAgent'>) {
    await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      this.store.record(tx, ctx.tenantId, this.fromContext(ctx, entry)),
    );
  }

  /**
   * Every entry of the range, oldest first, in pages of `size`; each page is read in its own
   * short transaction so an export of a long history never holds one open.
   */
  async *exportPages(
    ctx: AuthContext,
    filter: Omit<AuditFilter, 'limit'> & { from: Date; to: Date },
    size = 1000,
  ): AsyncGenerator<AuditRow[]> {
    let after: { at: Date; id: string } | undefined;
    for (;;) {
      const rows = await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
        this.store.page(tx, filter, size, after),
      );
      if (rows.length === 0) return;
      yield rows;
      const last = rows[rows.length - 1]!;
      after = { at: last.at, id: last.id };
      if (rows.length < size) return;
    }
  }
}
