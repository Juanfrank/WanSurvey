import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { CONFIG, type AppConfig } from '../config.js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthUserRow {
  id: string;
  passwordHash: string | null;
  status: string;
  totpEnabled: boolean;
  lastTenantId: string | null;
}

export interface SsoPublicConfig {
  tenantId: string;
  slug: string;
  entraTenantId: string;
  clientId: string;
  enabled: boolean;
}

export interface UserTenant {
  id: string;
  slug: string;
  name: string;
  memberStatus: string;
}

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

  /**
   * Runs `fn` in a transaction pinned to a tenant (RLS) and, optionally, to the acting user,
   * which is what lets a person update their own global account.
   */
  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, userId?: string): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    return this.withContext({ tenantId, userId }, fn);
  }

  /** User context only, for account-level changes that belong to no organisation. */
  async withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withContext({ userId }, fn);
  }

  private async withContext<T>(
    ctx: { tenantId?: string; userId?: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (ctx.userId !== undefined && !isUuid(ctx.userId)) throw new Error('Invalid user id');
    return this.db.transaction(async (tx) => {
      if (ctx.tenantId)
        await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
      if (ctx.userId) await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true)`);
      return fn(tx);
    });
  }

  // Login-time lookups run before any tenant context exists, through security-definer functions.

  async authUserByEmail(email: string): Promise<AuthUserRow | null> {
    const rows = await this.client<AuthUserRow[]>`
      select id, password_hash as "passwordHash", status, totp_enabled as "totpEnabled", last_tenant_id as "lastTenantId"
      from auth_user_by_email(${email})`;
    return rows[0] ?? null;
  }

  async userIdByEmail(email: string): Promise<string | null> {
    const rows = await this.client<
      { id: string | null }[]
    >`select user_id_by_email(${email}) as id`;
    return rows[0]?.id ?? null;
  }

  /** Organisations the user is an active member of (or every membership, with `includeInactive`). */
  async userTenants(userId: string, includeInactive = false): Promise<UserTenant[]> {
    return this.client<UserTenant[]>`
      select id, slug, name, member_status as "memberStatus" from user_tenants(${userId}, ${includeInactive})`;
  }

  async ssoEnforcedTenants(
    tenantIds: string[],
  ): Promise<{ tenantId: string; entraTenantId: string }[]> {
    if (tenantIds.length === 0) return [];
    return this.client<{ tenantId: string; entraTenantId: string }[]>`
      select tenant_id as "tenantId", entra_tenant_id as "entraTenantId"
      from sso_enforced_tenants(${tenantIds}::uuid[])`;
  }

  /** Public Entra settings of an organisation (never the secret), for starting a sign-in. */
  async ssoConfigBySlug(slug: string): Promise<SsoPublicConfig | null> {
    const rows = await this.client<SsoPublicConfig[]>`
      select tenant_id as "tenantId", slug, entra_tenant_id as "entraTenantId", client_id as "clientId", enabled
      from sso_config_by_slug(${slug})`;
    return rows[0] ?? null;
  }

  async ssoTenantsForDomain(domain: string): Promise<SsoPublicConfig[]> {
    return this.client<SsoPublicConfig[]>`
      select tenant_id as "tenantId", slug, entra_tenant_id as "entraTenantId", client_id as "clientId", enabled
      from sso_tenants_for_domain(${domain})`;
  }

  /** Revokes the user's sessions in every organisation (password reset). */
  async revokeAllSessions(userId: string): Promise<number> {
    const rows = await this.client<{ n: number }[]>`select revoke_user_sessions(${userId}) as n`;
    return rows[0]?.n ?? 0;
  }

  async onModuleDestroy() {
    await this.client.end({ timeout: 5 });
  }
}
