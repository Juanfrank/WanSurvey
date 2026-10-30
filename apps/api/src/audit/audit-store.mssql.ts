import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import type { MssqlTx } from '../db/mssql/database.js';
import type { AuditEntry } from './audit.service.js';

/**
 * The audit log on SQL Server (Kysely): what `audit.service.ts` does on PostgreSQL with Drizzle,
 * as a store for the switch (docs/roadmap.md). Append-only: the database refuses changes and
 * deletes (an INSTEAD OF trigger), and the application user may only insert and read.
 */
export interface AuditRow {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown>;
  at: Date;
}

export interface AuditFilter {
  action?: string;
  actorUserId?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  limit: number;
}

/**
 * An instant to the millisecond: a `Date` parameter travels as `datetime`, which rounds to 3.33 ms
 * and can land a millisecond off the `datetimeoffset(3)` it is compared with.
 */
const exact = (d: Date) => sql<Date>`CAST(${d.toISOString()} AS datetimeoffset(3))`;

export class AuditStore {
  /** Appends an entry inside the caller's tenant transaction so it commits with the change. */
  async record(tx: MssqlTx, tenantId: string, entry: AuditEntry): Promise<void> {
    await tx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        action: entry.action,
        actor_user_id: entry.actorUserId ?? null,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        details: JSON.stringify(entry.details ?? {}),
        ip: entry.ip ?? null,
        user_agent: entry.userAgent ?? null,
      })
      .execute();
  }

  /** Newest first. */
  async list(tx: MssqlTx, filter: AuditFilter): Promise<AuditRow[]> {
    let q = tx.selectFrom('audit_log').selectAll();
    if (filter.action) q = q.where('action', '=', filter.action);
    if (filter.actorUserId) q = q.where('actor_user_id', '=', filter.actorUserId);
    if (filter.targetId) q = q.where('target_id', '=', filter.targetId);
    if (filter.from) q = q.where('at', '>=', exact(filter.from));
    if (filter.to) q = q.where('at', '<=', exact(filter.to));
    const rows = await q.orderBy('at', 'desc').orderBy('id', 'desc').top(filter.limit).execute();
    return rows.map((r) => ({
      id: r.id.toLowerCase(),
      tenantId: r.tenant_id.toLowerCase(),
      actorUserId: r.actor_user_id?.toLowerCase() ?? null,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      ip: r.ip,
      userAgent: r.user_agent,
      details: JSON.parse(r.details) as Record<string, unknown>,
      at: r.at,
    }));
  }
}
