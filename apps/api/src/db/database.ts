import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { CONFIG, type AppConfig } from '../config.js';
import { PROCESS_ROLE, type ProcessRole } from '../jobs/role.js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Errors a transaction can simply be run again after (serialization failure, deadlock). */
const RETRYABLE = new Set(['40001', '40P01']);
/** The database is too busy for this request now: a lock or the statement took too long. */
const BUSY = new Set(['55P03', '57014']);
const ATTEMPTS = 3;

/** The Postgres error code of a (possibly wrapped) driver error. */
export function pgCode(e: unknown): string | undefined {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined, i = 0; x && i < 4; i++) {
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) return x.code;
    x = x.cause as typeof x;
  }
  return undefined;
}

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

  /** Per transaction: statement and lock time limits ('0' = none), as strings for set_config. */
  private readonly statementTimeout: string;
  private readonly lockTimeout: string;
  private readonly idleInTransaction: string;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Optional() @Inject(PROCESS_ROLE) role: ProcessRole = 'api',
  ) {
    const worker = role === 'worker';
    // A bounded pool per process. Idle connections are released and old ones renewed, so a
    // pooler or a failover never leaves the app holding dead connections.
    this.client = postgres(config.DATABASE_URL, {
      max: worker ? config.DB_WORKER_POOL_MAX : config.DB_POOL_MAX,
      idle_timeout: config.DB_IDLE_TIMEOUT_S,
      max_lifetime: config.DB_MAX_LIFETIME_S,
      connect_timeout: config.DB_CONNECT_TIMEOUT_S,
      prepare: config.DB_PREPARE,
      onnotice: () => {},
    });
    this.db = drizzle(this.client, { schema });
    this.statementTimeout = String(
      worker ? config.DB_WORKER_STATEMENT_TIMEOUT_MS : config.DB_STATEMENT_TIMEOUT_MS,
    );
    this.lockTimeout = String(config.DB_LOCK_TIMEOUT_MS);
    // A job may think for a while between statements (building an export): give it its time.
    this.idleInTransaction = String(
      worker
        ? Math.max(config.DB_IDLE_IN_TRANSACTION_MS, config.DB_WORKER_STATEMENT_TIMEOUT_MS)
        : config.DB_IDLE_IN_TRANSACTION_MS,
    );
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

  /**
   * One transaction with the context pinned by transaction-local settings (`set_config(…,
   * true)`, never session-level SET), so it works through a pooler in transaction mode. Time
   * limits are set the same way. A deadlock or serialization failure runs it again (it rolled
   * back entirely); a lock or statement timeout becomes 503 BUSY, for the client to retry.
   */
  private async withContext<T>(
    ctx: { tenantId?: string; userId?: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (ctx.userId !== undefined && !isUuid(ctx.userId)) throw new Error('Invalid user id');
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', ${this.statementTimeout}, true),
                       set_config('lock_timeout', ${this.lockTimeout}, true),
                       set_config('idle_in_transaction_session_timeout', ${this.idleInTransaction}, true)
                       ${ctx.tenantId ? sql`, set_config('app.tenant_id', ${ctx.tenantId}, true)` : sql``}
                       ${ctx.userId ? sql`, set_config('app.user_id', ${ctx.userId}, true)` : sql``}`,
          );
          return fn(tx);
        });
      } catch (e) {
        const code = pgCode(e);
        if (code && RETRYABLE.has(code) && attempt < ATTEMPTS) {
          // A short random pause, so the transactions that collided do not collide again.
          await new Promise((ok) => setTimeout(ok, 20 * attempt + Math.random() * 50));
          continue;
        }
        if (code && BUSY.has(code))
          throw new ServiceUnavailableException({
            code: 'BUSY',
            message: 'The server is busy; please try again in a moment',
          });
        throw e;
      }
    }
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

  /** The invitation a respondent's token belongs to, and its organisation. */
  async invitationByToken(hash: string): Promise<{ id: string; tenantId: string } | null> {
    const [r] = await this.client<{ id: string; tenant_id: string }[]>`
      select * from invitation_by_token(${hash})`;
    return r ? { id: r.id, tenantId: r.tenant_id } : null;
  }

  async invitationTenant(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const [r] = await this.client<{ t: string | null }[]>`select invitation_tenant(${id}) as t`;
    return r?.t ?? null;
  }

  async openLinkBySlug(slug: string): Promise<{ id: string; tenantId: string } | null> {
    const [r] = await this.client<{ id: string; tenant_id: string }[]>`
      select * from open_link_by_slug(${slug})`;
    return r ? { id: r.id, tenantId: r.tenant_id } : null;
  }

  async feedbackPointBySlug(slug: string): Promise<{ id: string; tenantId: string } | null> {
    const [r] = await this.client<{ id: string; tenant_id: string }[]>`
      select * from feedback_point_by_slug(${slug})`;
    return r ? { id: r.id, tenantId: r.tenant_id } : null;
  }

  async tenantsWithMailDue(): Promise<string[]> {
    const rows = await this.client<{ tenant_id: string }[]>`select * from tenants_with_mail_due()`;
    return rows.map((r) => r.tenant_id);
  }

  /** Every organisation, for nightly jobs. */
  async allTenantIds(): Promise<string[]> {
    const rows = await this.client<{ tenant_id: string }[]>`select * from all_tenant_ids()`;
    return rows.map((r) => r.tenant_id);
  }

  /** The organisation of a live summary link. */
  async shareLinkByHash(hash: string): Promise<{ id: string; tenantId: string } | null> {
    const [r] = await this.client<{ id: string; tenant_id: string }[]>`
      select * from share_link_by_hash(${hash})`;
    return r ? { id: r.id, tenantId: r.tenant_id } : null;
  }

  async onModuleDestroy() {
    await this.client.end({ timeout: 5 });
  }
}
