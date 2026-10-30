import { Kysely, MssqlDialect } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';

export interface MssqlOptions {
  /** Connections in the pool. */
  max?: number;
  /** A statement running longer than this fails (ms); 0: no limit. */
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
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
export function createMssqlDb<DB>(url: string, opts: MssqlOptions = {}): Kysely<DB> {
  const base = parseMssqlUrl(url);
  return new Kysely<DB>({
    dialect: new MssqlDialect({
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
