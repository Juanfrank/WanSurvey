import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { PROCESS_ROLE, type ProcessRole } from '../jobs/role.js';
import { CONFIG, type AppConfig } from '../config.js';
import { MssqlDatabase, type TenantFence } from './mssql/database.js';

/** The database of a process: SQL Server. */
@Injectable()
export class Engine implements OnModuleDestroy {
  readonly sql: MssqlDatabase;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Optional() @Inject(PROCESS_ROLE) role: ProcessRole = 'api',
  ) {
    // The worker has a pool of its own, and its statements may think for a while (an export).
    const worker = role === 'worker';
    this.sql = new MssqlDatabase(config.DATABASE_URL, {
      max: worker ? config.DB_WORKER_POOL_MAX : config.DB_POOL_MAX,
      lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
      requestTimeoutMs: worker
        ? config.DB_WORKER_STATEMENT_TIMEOUT_MS
        : config.DB_STATEMENT_TIMEOUT_MS,
    });
  }

  /**
   * Every organisation with its slug and creation time, oldest first, whatever the fence (how
   * single-tenant mode chooses the one it serves).
   */
  everyTenant(): Promise<{ id: string; slug: string; createdAt: Date }[]> {
    return this.sql.everyTenant();
  }

  /** Closes the organisations `opens` refuses (single-tenant mode); see `MssqlDatabase.fence`. */
  fence(opens: TenantFence | null): void {
    this.sql.fence(opens);
  }

  /** Whether the organisation may be opened by this process. */
  opens(tenantId: string): Promise<boolean> {
    return this.sql.opens(tenantId);
  }

  /** Every organisation that may be opened here (only the served one in single-tenant mode). */
  allTenantIds(): Promise<string[]> {
    return this.sql.allTenantIds();
  }

  /** Every organisation, closed ones included: only for the retention jobs. */
  allTenantIdsForRetention(): Promise<string[]> {
    return this.sql.allTenantIdsForRetention();
  }

  /** The organisation and id of a live share link, from the hash of its token. */
  shareLinkByHash(hash: string): Promise<{ id: string; tenantId: string } | null> {
    return this.sql.shareLinkByHash(hash);
  }

  /** The organisation of an invitation, from its id. */
  invitationTenant(id: string, opts: { evenClosed?: boolean } = {}): Promise<string | null> {
    return this.sql.invitationTenant(id, opts);
  }

  /** The organisations that invited an address (e-mail or number). */
  tenantsInvitedAt(address: string, opts: { evenClosed?: boolean } = {}): Promise<string[]> {
    return this.sql.tenantsInvitedAt(address, opts);
  }

  /** The organisations with invitations or reminders due. */
  tenantsWithMailDue(): Promise<string[]> {
    return this.sql.tenantsWithMailDue();
  }

  /** Whether the database answers. */
  probe(): Promise<boolean> {
    return this.sql.probe();
  }

  async onModuleDestroy() {
    await this.sql.destroy();
  }
}
