import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Column, getTableColumns, is, Param, Placeholder, SQL, sql, type Table } from 'drizzle-orm';
import type { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { CONFIG, type AppConfig } from '../config.js';
import { PROCESS_ROLE, type ProcessRole } from '../jobs/role.js';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Lookups by a public key (link token, slug) that find the organisation before any context. */
export type PublicLookup = 'invitation_by_token' | 'open_link_by_slug' | 'feedback_point_by_slug';

/** Result fields of a prepared query: a column, or a group of columns (a joined table's row). */
type Fields = Record<string, Column | 'raw' | Record<string, Column>>;

/**
 * A table's columns for a hand-written prepared query, as `"alias"."col" as "group__col"`:
 * with `{ [group]: getTableColumns(table) }` in the fields, the row comes back as an object.
 */
export function columnsAs(table: Table, alias: string, group: string): SQL {
  const cols = Object.values(getTableColumns(table)).map(
    (c) => `"${alias}"."${c.name}" as "${group}__${c.name}"`,
  );
  return sql.raw(cols.join(', '));
}

/**
 * A query built once and run in any transaction. Drizzle builds a query's SQL each time it
 * runs, which on the hot paths (each respondent and device request) costs more CPU than the
 * query itself; this keeps the text and where each argument goes, runs it on the
 * transaction's own connection (Postgres keeps it prepared there, DB_PREPARE) and maps the
 * row back with the columns' own decoders, as Drizzle would.
 */
export class Prepared<Row> {
  private text?: string;
  /** Each parameter: an argument by name (with the column's encoder, in inserts) or a constant. */
  private slots?: ({ name: string; encode?: (v: unknown) => unknown } | { value: unknown })[];

  /**
   * `build` returns the query (a Drizzle builder, or `sql` written by hand) with
   * `sql.placeholder(name)` for each argument. `fields` maps each result key to its column
   * (`getTableColumns(table)` for whole rows), to `'raw'` for a computed value read as the
   * driver returns it, or to a group of columns selected with
   * `columnsAs` (null when the group's columns are all null, as for an outer join).
   */
  constructor(
    private readonly build: (tx: Tx) => { toSQL(): { sql: string; params: unknown[] } } | SQL,
    private readonly fields: Fields,
  ) {}

  async run(tx: Tx, args: Record<string, unknown>): Promise<Row[]> {
    if (!this.text) {
      const built = this.build(tx);
      const q = is(built, SQL)
        ? (tx as unknown as { dialect: PgDialect }).dialect.sqlToQuery(built)
        : (built as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
      this.slots = q.params.map((p) => {
        if (is(p, Placeholder)) return { name: p.name };
        // Insert values come wrapped with the column that encodes them.
        if (is(p, Param) && is(p.value, Placeholder)) {
          const encoder = p.encoder as { mapToDriverValue?(v: unknown): unknown } | undefined;
          return {
            name: (p.value as Placeholder<string>).name,
            encode: encoder?.mapToDriverValue?.bind(encoder),
          };
        }
        return { value: p };
      });
      this.text = q.sql;
    }
    const params = this.slots!.map((s) => {
      if (!('name' in s)) return s.value;
      const v = args[s.name];
      return s.encode && v !== null && v !== undefined ? s.encode(v) : v;
    });
    const client = (tx as unknown as { session: { client: postgres.Sql } }).session.client;
    const raw = await client.unsafe(this.text, params as postgres.ParameterOrJSON<never>[]);
    const decode = (col: Column, v: unknown) =>
      v === null || v === undefined ? null : col.mapFromDriverValue(v);
    return raw.map((r) => {
      const rec = r as Record<string, unknown>;
      const row: Record<string, unknown> = {};
      for (const [key, f] of Object.entries(this.fields)) {
        // A computed value (a count) is taken as the driver gives it.
        if (f === 'raw') {
          row[key] = rec[key] ?? null;
          continue;
        }
        if (is(f, Column)) {
          row[key] = decode(f, rec[f.name]);
          continue;
        }
        const group: Record<string, unknown> = {};
        let any = false;
        for (const [k, col] of Object.entries(f)) {
          const v = rec[`${key}__${col.name}`];
          if (v !== null && v !== undefined) any = true;
          group[k] = decode(col, v);
        }
        row[key] = any ? group : null;
      }
      return row as Row;
    });
  }
}

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

/**
 * A unique index refused a row (a race to create the same thing): PostgreSQL 23505, SQL Server
 * 2601 or 2627.
 */
export function isUniqueViolation(e: unknown): boolean {
  if (pgCode(e) === '23505') return true;
  for (let x = e as { number?: unknown; cause?: unknown } | undefined, i = 0; x && i < 4; i++) {
    if (x.number === 2601 || x.number === 2627) return true;
    x = x.cause as typeof x;
  }
  return false;
}

/** The database cannot be reached now (failover, restart, no free connection). */
const UNAVAILABLE = new Set(['57P01', '57P02', '57P03', '53300']);
const DRIVER_UNAVAILABLE = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

function unavailable(e: unknown): boolean {
  const code = pgCode(e);
  if (code && (UNAVAILABLE.has(code) || code.startsWith('08'))) return true;
  for (let x = e as { code?: unknown; cause?: unknown } | undefined, i = 0; x && i < 4; i++) {
    if (typeof x.code === 'string' && DRIVER_UNAVAILABLE.has(x.code)) return true;
    x = x.cause as typeof x;
  }
  return false;
}

/** An error worth trying again later: busy, unreachable, or a 503 made from one. */
export function isTransient(e: unknown): boolean {
  const code = pgCode(e);
  if (code && (BUSY.has(code) || RETRYABLE.has(code))) return true;
  if (unavailable(e)) return true;
  return e instanceof ServiceUnavailableException;
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
  /**
   * One connection of its own for health checks, so a probe never queues behind a busy pool
   * and an instance is not taken out of rotation only because it is serving requests.
   */
  private readonly probeClient: postgres.Sql;

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
    // With SQL Server as the engine the PostgreSQL clients are never used (they connect lazily).
    const url =
      config.DB_ENGINE === 'mssql' ? 'postgres://unused@127.0.0.1:1/unused' : config.DATABASE_URL;
    this.probeClient = postgres(url, {
      max: 1,
      idle_timeout: 60,
      connect_timeout: 5,
      prepare: false,
      onnotice: () => {},
    });
    this.client = postgres(url, {
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

  /**
   * Finds a link's organisation and works in it in one transaction: the lookup (a
   * security-definer function) and the context are set by the same first statement, where
   * a lookup followed by `withTenant` takes two transactions and an extra round trip on every
   * respondent request. `fn` gets null when nothing matches (no context is set then).
   */
  async withTenantOf<T>(
    lookup: PublicLookup,
    key: string,
    fn: (tx: Tx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ): Promise<T> {
    return this.withContext({ lookup: { fn: lookup, key } }, async (tx, found) => fn(tx, found));
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
    ctx: { tenantId?: string; userId?: string; lookup?: { fn: PublicLookup; key: string } },
    fn: (tx: Tx, found: { id: string; tenantId: string } | null) => Promise<T>,
  ): Promise<T> {
    if (ctx.userId !== undefined && !isUuid(ctx.userId)) throw new Error('Invalid user id');
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const limits = sql`set_config('statement_timeout', ${this.statementTimeout}, true),
                       set_config('lock_timeout', ${this.lockTimeout}, true),
                       set_config('idle_in_transaction_session_timeout', ${this.idleInTransaction}, true)`;
          if (ctx.lookup) {
            // The select list runs after the function's row is found, so the organisation is
            // set for everything the transaction does next.
            const rows = (await tx.execute(
              sql`select f.id, f.tenant_id, ${limits},
                         set_config('app.tenant_id', f.tenant_id::text, true)
                  from ${sql.raw(ctx.lookup.fn)}(${ctx.lookup.key}) f`,
            )) as unknown as { id: string; tenant_id: string }[];
            const r = rows[0];
            if (!r) await tx.execute(sql`select ${limits}`);
            return fn(tx, r ? { id: r.id, tenantId: r.tenant_id } : null);
          }
          await tx.execute(
            sql`select ${limits}
                       ${ctx.tenantId ? sql`, set_config('app.tenant_id', ${ctx.tenantId}, true)` : sql``}
                       ${ctx.userId ? sql`, set_config('app.user_id', ${ctx.userId}, true)` : sql``}`,
          );
          return fn(tx, null);
        });
      } catch (e) {
        const code = pgCode(e);
        if (code && RETRYABLE.has(code) && attempt < ATTEMPTS) {
          // A short random pause, so the transactions that collided do not collide again.
          await new Promise((ok) => setTimeout(ok, 20 * attempt + Math.random() * 50));
          continue;
        }
        if ((code && BUSY.has(code)) || unavailable(e))
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

  /** Until when the account is locked after failed attempts; null when it is not. */
  async accountLockedUntil(userId: string): Promise<Date | null> {
    const [r] = await this.client<{ until: string | Date | null }[]>`
      select account_locked_until(${userId}) as until`;
    // Drizzle leaves dates as text on this client.
    return r?.until ? new Date(r.until) : null;
  }

  /** Counts a failed password or code; returns the end of the lock it caused, if any. */
  async accountFailed(userId: string, max: number, lockSeconds: number): Promise<Date | null> {
    const [r] = await this.client<{ until: string | Date | null }[]>`
      select account_failed(${userId}, ${max}, ${lockSeconds}) as until`;
    return r?.until ? new Date(r.until) : null;
  }

  async accountSucceeded(userId: string): Promise<void> {
    await this.client`select account_succeeded(${userId})`;
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

  /** An organisation's id by slug, before any session (security-definer function). */
  async tenantIdBySlug(slug: string): Promise<string | null> {
    const [r] = await this.client<{ id: string | null }[]>`select tenant_id_by_slug(${slug}) as id`;
    return r?.id ?? null;
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

  /** Whether the database answers, within five seconds, on the probe's own connection. */
  async probe(): Promise<boolean> {
    try {
      await Promise.race([
        this.probeClient`select 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref()),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.client.end({ timeout: 5 });
    await this.probeClient.end({ timeout: 1 });
  }
}
