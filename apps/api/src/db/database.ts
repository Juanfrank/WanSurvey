import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { CONFIG, type AppConfig } from '../config.js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Connection as the restricted application role. All tenant data is read and written inside
 * `withTenant`, which pins `app.tenant_id` for the transaction so Postgres RLS filters every row.
 */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly client: postgres.Sql;
  readonly db: Db;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.client = postgres(config.DATABASE_URL, { max: 10, onnotice: () => {} });
    this.db = drizzle(this.client, { schema });
  }

  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  }

  /** Resolves a tenant slug at login (security-definer function; no tenant context yet). */
  async tenantIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.client<
      { id: string | null }[]
    >`select tenant_id_by_slug(${slug}) as id`;
    return rows[0]?.id ?? null;
  }

  async onModuleDestroy() {
    await this.client.end({ timeout: 5 });
  }
}
