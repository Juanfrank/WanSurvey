import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Database } from './database.js';
import { MssqlDatabase } from './mssql/database.js';

/**
 * Which database a process runs on. PostgreSQL (`Database`) serves everything until the switch;
 * with DB_ENGINE=mssql the modules that have moved use `mssql`, and the rest, still on
 * PostgreSQL, are not usable (docs/roadmap.md, "SQL Server replaces PostgreSQL").
 */
@Injectable()
export class Engine implements OnModuleDestroy {
  readonly kind: AppConfig['DB_ENGINE'];
  /** Present with DB_ENGINE=mssql. */
  readonly mssql: MssqlDatabase | null;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    private readonly postgres: Database,
  ) {
    this.kind = config.DB_ENGINE;
    this.mssql =
      config.DB_ENGINE === 'mssql'
        ? new MssqlDatabase(config.DATABASE_URL, {
            max: config.DB_POOL_MAX,
            lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
            requestTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
          })
        : null;
  }

  /** The SQL Server database, for a module that has moved; fails where it is not the engine. */
  get sql(): MssqlDatabase {
    if (!this.mssql) throw new Error('This process does not run on SQL Server');
    return this.mssql;
  }

  /** Every organisation, for jobs that work across them. */
  allTenantIds(): Promise<string[]> {
    return this.mssql ? this.mssql.allTenantIds() : this.postgres.allTenantIds();
  }

  /** The organisation and id of a live share link, from the hash of its token. */
  shareLinkByHash(hash: string): Promise<{ id: string; tenantId: string } | null> {
    return this.mssql ? this.mssql.shareLinkByHash(hash) : this.postgres.shareLinkByHash(hash);
  }

  /** Whether the database answers. */
  probe(): Promise<boolean> {
    return this.mssql ? this.mssql.probe() : this.postgres.probe();
  }

  async onModuleDestroy() {
    await this.mssql?.destroy();
  }
}
