import { Kysely, MssqlDialect, type DatabaseConnection, type Driver } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';

export interface MssqlOptions {
  /** Connections in the pool. */
  max?: number;
  /** A statement running longer than this fails (ms); 0: no limit. */
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * How long a statement may wait for a lock (ms). Every statement is sent with
   * `SET LOCK_TIMEOUT n;` in front: Kysely runs each one through `sp_executesql`, where a SET
   * does not outlast the statement, so setting it once on the connection would do nothing. Not for
   * the migrations, whose DDL must open its batch.
   */
  lockTimeoutMs?: number;
}

/**
 * `mssql://user:password@host:1433/database?encrypt=true&trustServerCertificate=false`:
 * encrypted by default, and the certificate checked unless told otherwise (a local container
 * has a self-signed one).
 */
export function parseMssqlUrl(url: string): Tedious.ConnectionConfiguration {
  const u = new URL(url);
  if (u.protocol !== 'mssql:') throw new Error('An mssql:// URL is required');
  const flag = (name: string, fallback: boolean) => {
    const v = u.searchParams.get(name);
    return v === null ? fallback : v === 'true';
  };
  return {
    server: u.hostname,
    authentication: {
      type: 'default',
      options: {
        userName: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      },
    },
    options: {
      port: u.port ? Number(u.port) : 1433,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
      encrypt: flag('encrypt', true),
      trustServerCertificate: flag('trustServerCertificate', false),
    },
  };
}

/** A Kysely instance on SQL Server (tedious), pooled with tarn. */
/** A dialect whose statements carry the lock time limit (see `MssqlOptions.lockTimeoutMs`). */
class LockTimeoutDialect extends MssqlDialect {
  constructor(
    config: ConstructorParameters<typeof MssqlDialect>[0],
    private readonly lockTimeoutMs: number,
  ) {
    super(config);
  }

  override createDriver(): Driver {
    const driver = super.createDriver();
    const prefix = `SET LOCK_TIMEOUT ${Math.trunc(this.lockTimeoutMs)}; `;
    const timed = (c: DatabaseConnection): DatabaseConnection =>
      new Proxy(c, {
        get(target, prop) {
          if (prop === 'executeQuery')
            return (q: Parameters<DatabaseConnection['executeQuery']>[0]) =>
              target.executeQuery({ ...q, sql: prefix + q.sql });
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    return new Proxy(driver, {
      get(target, prop) {
        if (prop === 'acquireConnection')
          return async () => timed(await target.acquireConnection());
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
}

export function createMssqlDb<DB>(url: string, opts: MssqlOptions = {}): Kysely<DB> {
  const base = parseMssqlUrl(url);
  const Dialect = (config: ConstructorParameters<typeof MssqlDialect>[0]) =>
    opts.lockTimeoutMs !== undefined && opts.lockTimeoutMs >= 0
      ? new LockTimeoutDialect(config, opts.lockTimeoutMs)
      : new MssqlDialect(config);
  return new Kysely<DB>({
    dialect: Dialect({
      tarn: { ...Tarn, options: { min: 0, max: opts.max ?? 10 } },
      tedious: {
        ...Tedious,
        connectionFactory: () =>
          new Tedious.Connection({
            ...base,
            options: {
              ...base.options,
              requestTimeout: opts.requestTimeoutMs ?? 30_000,
              connectTimeout: opts.connectTimeoutMs ?? 10_000,
            },
          }),
      },
    }),
  });
}

/** The SQL Server error number of a (possibly wrapped) driver error. */
export function mssqlNumber(e: unknown): number | undefined {
  for (let x = e as { number?: unknown; cause?: unknown } | undefined, i = 0; x && i < 4; i++) {
    if (typeof x.number === 'number') return x.number;
    x = x.cause as typeof x;
  }
  return undefined;
}
