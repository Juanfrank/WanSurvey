import { ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { isUuid } from '../database.js';
import { createMssqlDb, mssqlNumber, type MssqlOptions } from './connection.js';
import type { MssqlSchema } from './schema.js';

export type MssqlTx = Transaction<MssqlSchema>;

/** Deadlock victim: the transaction rolled back entirely, so it can simply run again. */
const DEADLOCK = 1205;
/** The lock wait exceeded LOCK_TIMEOUT. */
const LOCK_TIMEOUT = 1222;
const ATTEMPTS = 3;

export interface MssqlLimits {
  /** How long a statement may wait for a lock (ms); -1: forever. */
  lockTimeoutMs: number;
}

/**
 * The SQL Server counterpart of `Database.withTenant`: a transaction whose SESSION_CONTEXT
 * carries the organisation, which the security policy (mssql/0001) filters every row by.
 * SESSION_CONTEXT belongs to the connection, not the transaction, and pooled connections are
 * reused: it is set first thing in every transaction and cleared before it ends, so a
 * connection never carries one organisation's context into another's work.
 */
export class MssqlDatabase {
  readonly db: Kysely<MssqlSchema>;

  constructor(
    url: string,
    opts: MssqlOptions & Partial<MssqlLimits> = {},
    private readonly limits: MssqlLimits = { lockTimeoutMs: opts.lockTimeoutMs ?? 5_000 },
  ) {
    this.db = createMssqlDb<MssqlSchema>(url, opts);
  }

  async withTenant<T>(tenantId: string, fn: (tx: MssqlTx) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction().execute(async (tx) => {
          await sql`SET LOCK_TIMEOUT ${sql.lit(this.limits.lockTimeoutMs)}`.execute(tx);
          await sql`EXEC sp_set_session_context @key = N'tenant_id', @value = ${tenantId}`.execute(
            tx,
          );
          try {
            return await fn(tx);
          } finally {
            // Before the commit or rollback, on the same connection.
            await sql`EXEC sp_set_session_context @key = N'tenant_id', @value = NULL`
              .execute(tx)
              .catch(() => undefined);
          }
        });
      } catch (e) {
        const n = mssqlNumber(e);
        if (n === DEADLOCK && attempt < ATTEMPTS) {
          await new Promise((ok) => setTimeout(ok, 20 * attempt + Math.random() * 50));
          continue;
        }
        if (n === LOCK_TIMEOUT)
          throw new ServiceUnavailableException({
            code: 'BUSY',
            message: 'The server is busy; please try again in a moment',
          });
        throw e;
      }
    }
  }

  /** An organisation's id by slug, before any session (a procedure that runs as the owner). */
  async tenantIdBySlug(slug: string): Promise<string | null> {
    const res = await sql<{ id: string }>`EXEC dbo.tenant_id_by_slug @slug = ${slug}`.execute(
      this.db,
    );
    return res.rows[0]?.id.toLowerCase() ?? null;
  }

  /** Whether the database answers. */
  async probe(): Promise<boolean> {
    try {
      await sql`SELECT 1 AS ok`.execute(this.db);
      return true;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }
}
