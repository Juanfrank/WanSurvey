import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { enqueueFromAudit } from '../webhooks/outbox.js';
import { instant } from '../db/mssql/instant.js';
import type { MssqlTx } from '../db/mssql/database.js';
import type { AuditEntry } from './audit.service.js';

/**
 * The audit log on SQL Server (Kysely), for `audit.service.ts`. Append-only: the database refuses changes and
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
  /** Any of these actions (a preset such as "corrections" or "exports"). */
  actions?: string[];
  actorUserId?: string;
  targetId?: string;
  /** Entries about this project: on it, or naming it in their details. */
  projectId?: string;
  /** Entries about a case: its id or its external id, as target or in the details. */
  caseRef?: string;
  from?: Date;
  to?: Date;
  /** Newest-first paging: only entries older than this one. */
  before?: { at: Date; id: string };
  limit: number;
}

const allOf = (tx: MssqlTx) => tx.selectFrom('audit_log').selectAll();
type Q = ReturnType<typeof allOf>;

/** The entries the filters every read of the log shares select (the screen and the export). */
function filtered(tx: MssqlTx, f: Omit<AuditFilter, 'limit' | 'before'>): Q {
  let r = allOf(tx);
  if (f.action) r = r.where('action', '=', f.action);
  if (f.actions?.length) r = r.where('action', 'in', f.actions);
  if (f.actorUserId) r = r.where('actor_user_id', '=', f.actorUserId);
  if (f.targetId) r = r.where('target_id', '=', f.targetId);
  if (f.from) r = r.where('at', '>=', instant(f.from));
  if (f.to) r = r.where('at', '<=', instant(f.to));
  if (f.projectId) {
    const p = f.projectId.toLowerCase();
    r = r.where(
      sql<boolean>`(LOWER(target_id) = ${p} OR LOWER(JSON_VALUE(details, '$.projectId')) = ${p})`,
    );
  }
  if (f.caseRef) {
    const c = f.caseRef.toLowerCase();
    r = r.where(
      sql<boolean>`(LOWER(target_id) = ${c} OR LOWER(JSON_VALUE(details, '$.caseId')) = ${c} OR LOWER(JSON_VALUE(details, '$.externalId')) = ${c})`,
    );
  }
  return r;
}

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
    // Some entries are webhook events: written to the outbox in this same transaction.
    await enqueueFromAudit(tx, tenantId, entry);
  }

  /**
   * Oldest first, a page after the row (`at`, `id`) the previous page ended at, for exports: the
   * keyset keeps the cost of a page the same however far the export has gone.
   */
  async page(
    tx: MssqlTx,
    filter: Omit<AuditFilter, 'limit'> & { from: Date; to: Date },
    size: number,
    after?: { at: Date; id: string },
  ): Promise<AuditRow[]> {
    let q = filtered(tx, filter);
    if (after)
      q = q.where((eb) =>
        eb.or([
          eb('at', '>', instant(after.at)),
          eb.and([eb('at', '=', instant(after.at)), eb('id', '>', after.id)]),
        ]),
      );
    const rows = await q.orderBy('at', 'asc').orderBy('id', 'asc').top(size).execute();
    return rows.map(toRow);
  }

  /** Newest first, a page after `before` (the last entry of the previous page) when given. */
  async list(tx: MssqlTx, filter: AuditFilter): Promise<AuditRow[]> {
    let q = filtered(tx, filter);
    const before = filter.before;
    if (before)
      q = q.where((eb) =>
        eb.or([
          eb('at', '<', instant(before.at)),
          eb.and([eb('at', '=', instant(before.at)), eb('id', '<', before.id)]),
        ]),
      );
    const rows = await q.orderBy('at', 'desc').orderBy('id', 'desc').top(filter.limit).execute();
    return rows.map(toRow);
  }
}

const toRow = (r: {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: string;
  at: Date;
}): AuditRow => ({
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
});
