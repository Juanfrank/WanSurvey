import { isIP } from 'node:net';
import { z } from 'zod';

/** An optional setting; empty counts as not set (App Service keeps empty settings). */
const optionalText = (max: number) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(max).optional());

/** An optional GUID, such as Entra's ids (a typo would only fail at the first sign-in). */
const optionalGuid = (message: string) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message)
      .optional(),
  );

export const SSO_CALLBACK_PATH = '/api/v1/auth/sso/callback';

/**
 * Who may call /health: IP addresses and CIDR ranges, comma-separated ("10.0.0.0/8,::1").
 * Empty: everyone.
 */
const ipList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  )
  .superRefine((list, ctx) => {
    for (const entry of list) {
      const [addr, bits, extra] = entry.split('/');
      const family = isIP(addr ?? '');
      const max = family === 4 ? 32 : 128;
      const ok =
        family !== 0 &&
        extra === undefined &&
        (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max));
      if (!ok)
        ctx.addIssue({ code: 'custom', message: `Not an IP address or CIDR range: ${entry}` });
    }
  });

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /**
   * The database engine. PostgreSQL serves production until the switch (docs/roadmap.md); with
   * `mssql`, DATABASE_URL and DATABASE_ADMIN_URL are `mssql://…` URLs, and the modules that have
   * moved use SQL Server (the rest still need PostgreSQL and are not usable yet).
   */
  DB_ENGINE: z.enum(['postgres', 'mssql']).default('postgres'),
  /** Connection as the restricted application role (RLS enforced). */
  DATABASE_URL: z.string().url(),
  /** Owner/superuser connection, used only for migrations and seeding. */
  DATABASE_ADMIN_URL: z.string().url().optional(),
  /**
   * Database connections per process (API, worker). Size them so that, over every instance of
   * both, they stay under the server's max_connections (or the pooler's pool size).
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DB_WORKER_POOL_MAX: z.coerce.number().int().min(1).max(200).default(5),
  /** Idle connections are closed after this many seconds; connections are renewed after 30 min. */
  DB_IDLE_TIMEOUT_S: z.coerce.number().int().min(0).default(30),
  DB_MAX_LIFETIME_S: z.coerce.number().int().min(60).default(1800),
  DB_CONNECT_TIMEOUT_S: z.coerce.number().int().min(1).default(10),
  /**
   * Server-side prepared statements. Turn off (false) behind a pooler in transaction mode, such
   * as Azure's built-in PgBouncer on port 6432, unless it supports them.
   */
  DB_PREPARE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** A request's statement and lock waits are cut after these (ms); jobs get a longer statement time. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  DB_WORKER_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(600_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).default(5_000),
  /** A transaction left idle this long (ms) is ended by the server, releasing its locks. */
  DB_IDLE_IN_TRANSACTION_MS: z.coerce.number().int().min(0).default(60_000),
  /**
   * Requests handled at once per API process; beyond it the API answers 503 with Retry-After
   * instead of queueing without limit (load shedding). 0 turns it off.
   */
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(0).default(200),
  /**
   * HTTP keep-alive (ms): longer than the load balancer's idle timeout in front of the API, so
   * the balancer never reuses a connection the API has just closed (sporadic 502s).
   */
  HTTP_KEEPALIVE_MS: z.coerce.number().int().min(1000).default(65_000),
  /** 32-byte key (base64) for field-level encryption of secrets such as TOTP seeds. */
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64'),
  /**
   * The app's public address: links in e-mails and the Microsoft redirect URI
   * ({PUBLIC_WEB_URL}/api/v1/auth/sso/callback). The API answers /api on this same address:
   * itself from the zip, through Vite's proxy in development.
   */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  /** Microsoft identity platform host; overridable for tests or sovereign clouds. */
  ENTRA_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
  /**
   * Sign-in with e-mail and password. Off ('false') where only Microsoft (Entra ID) is used:
   * the sign-in page shows the Microsoft button alone and the password endpoints refuse.
   */
  PASSWORD_LOGIN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** The organisation (slug) the Microsoft button signs in to when no e-mail is given. */
  SSO_DEFAULT_ORG: optionalText(64),
  /**
   * Microsoft sign-in of SSO_DEFAULT_ORG from the deployment (App Service settings), used
   * instead of the organisation's own settings: with password sign-in off, nobody could sign
   * in to configure it otherwise. The secret should come from Key Vault.
   */
  ENTRA_TENANT_ID: optionalGuid('Directory (tenant) ID, a GUID'),
  ENTRA_CLIENT_ID: optionalGuid('Application (client) ID, a GUID'),
  ENTRA_CLIENT_SECRET: optionalText(500),
  /**
   * The redirect URI registered in the Entra app, exactly: {public address}/api/v1/auth/sso/callback.
   * Without the deployment's Microsoft sign-in, organisations' own directories use
   * PUBLIC_WEB_URL + that path.
   */
  ENTRA_REDIRECT_URI: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .url()
      .refine((v) => v.endsWith(SSO_CALLBACK_PATH), `Must end with ${SSO_CALLBACK_PATH}`)
      .refine(
        (v) => v.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(v),
        'Must be https (http only for localhost)',
      )
      .optional(),
  ),
  /**
   * With password sign-in on, 'true' requires Microsoft for SSO_DEFAULT_ORG (owners keep their
   * password, as with an organisation's enforceSso). With it off, Microsoft is the only way anyway.
   */
  ENTRA_ENFORCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** E-mail domains, comma-separated, whose people may sign in through ENTRA_TENANT_ID. */
  ENTRA_ALLOWED_DOMAINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Failed passwords or codes in a row that lock an account, from any address; 0: never. */
  LOGIN_LOCK_AFTER: z.coerce.number().int().min(0).default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  /**
   * Requests per minute from one IP address over all routes: a ceiling against floods. A field
   * office behind one address shares it, so it is well above one person's needs.
   */
  RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(5000),
  /** Sample import limits. */
  IMPORT_MAX_MB: z.coerce.number().positive().default(20),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(200_000),
  /** Geocoding of case addresses: off unless set; addresses are sent to the service. */
  GEOCODER: z.enum(['none', 'nominatim']).default('none'),
  GEOCODER_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  /** Contact e-mail sent to Nominatim, as its usage policy requires. */
  GEOCODER_EMAIL: z.string().email().optional(),
  /** Addresses geocoded per request at most. */
  GEOCODE_MAX: z.coerce.number().int().positive().default(5000),
  /** How e-mail leaves: logged, written as files (development, tests), or SMTP. */
  MAILER: z.enum(['console', 'file', 'smtp']).default('console'),
  /** Folder for MAILER=file (one JSON file per message). */
  MAIL_OUTBOX_DIR: z.string().optional(),
  /** SMTP server, e.g. smtps://user:pass@smtp.example.org:465 (MAILER=smtp). */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('WanSurvey <encuestas@localhost>'),
  /** Shared secret the mail provider sends in `x-webhook-secret` with delivery events. */
  MAIL_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Base of respondent links; the web app by default. */
  PUBLIC_SURVEY_URL: z.string().url().optional(),
  /**
   * Redis for background jobs and live updates (M1, M2). Without it, jobs run inside the API
   * process (development and tests); production sets it and runs `node dist/worker.js` too.
   */
  REDIS_URL: z.string().url().optional(),
  /**
   * The worker answers `GET /health` on this port when set: hosts such as Azure App Service
   * restart a container that does not answer HTTP.
   */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().optional(),
  /** IPs and CIDR ranges allowed to call /health (404 for the rest); empty: everyone. */
  HEALTH_ALLOWED_IPS: ipList,
  /** Proxies in front of the API (load balancer, nginx…), for the client address. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  /**
   * Jobs a worker process runs at once: light ones (e-mail, figures, privacy) and heavy ones
   * (exports, which hold a file in memory). Keep the sum within DB_WORKER_POOL_MAX.
   */
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  HEAVY_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  /** Without Redis: the wait before a failed job's second try (doubled for the third). */
  JOB_RETRY_MS: z.coerce.number().int().min(0).default(2000),
  /**
   * When the worker refreshes the analysis model (schema bi), as cron in UTC (every 6 hours;
   * nothing runs when no data changed); 'off' never.
   */
  BI_REFRESH_CRON: z.string().trim().min(1).default('40 */6 * * *'),
  /** Days an export's file is kept before it is deleted (the request stays, as expired); 0 keeps them. */
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
  /**
   * The built web app (apps/web/dist), served by the API itself when set: where nothing else
   * serves it (App Service from a zip, without nginx).
   */
  WEB_DIST: optionalText(1000),
  /** Largest export file in bytes, counted as it is written (under ZIP's 4 GiB). */
  EXPORT_MAX_BYTES: z.coerce.number().int().min(1).max(2_147_483_647).default(2_000_000_000),
  /**
   * Where export files go as they are written: 'blob' (Azure Blob Storage; required in
   * production, where the API and the worker share no disk) or 'local' (a directory, for
   * development and tests on one machine).
   */
  EXPORT_STORAGE: z.enum(['blob', 'local']).optional(),
  /** 'local': the directory (created if missing). */
  EXPORT_DIR: optionalText(1000),
  /**
   * 'blob': the container's URL (https://<account>.blob.core.windows.net/exports), reached
   * with the app's managed identity (AZURE_CLIENT_ID for a user-assigned one)…
   */
  EXPORT_BLOB_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** The user-assigned managed identity's client id (App Service sets no default one). */
  AZURE_CLIENT_ID: optionalText(100),
  /** …or a connection string (Azurite in development and tests), with EXPORT_BLOB_CONTAINER. */
  AZURE_STORAGE_CONNECTION_STRING: optionalText(2000),
  EXPORT_BLOB_CONTAINER: z.string().min(3).max(63).default('exports'),
  /** How often the e-mail dispatcher runs (ms); 0 turns it off. */
  DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Optional: OpenTelemetry/Sentry are wired only when configured. */
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});
export type AppConfig = z.infer<typeof Env>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const parsed = Env.safeParse(env);
  if (parsed.success && parsed.data.GEOCODER === 'nominatim' && !parsed.data.GEOCODER_EMAIL) {
    throw new Error('Invalid configuration:\n  GEOCODER_EMAIL: required when GEOCODER=nominatim');
  }
  if (parsed.success && parsed.data.MAILER === 'file' && !parsed.data.MAIL_OUTBOX_DIR)
    throw new Error('Invalid configuration:\n  MAIL_OUTBOX_DIR: required when MAILER=file');
  if (parsed.success && parsed.data.MAILER === 'smtp' && !parsed.data.SMTP_URL)
    throw new Error('Invalid configuration:\n  SMTP_URL: required when MAILER=smtp');
  if (parsed.success) {
    const d = parsed.data;
    // Not every module has moved to SQL Server yet: refuse it where real data would be kept.
    if (d.DB_ENGINE === 'mssql' && d.NODE_ENV === 'production')
      throw new Error(
        'Invalid configuration:\n  DB_ENGINE: mssql is not ready for production (modules still on PostgreSQL)',
      );
    if ((d.DB_ENGINE === 'mssql') !== /^mssql:/.test(d.DATABASE_URL))
      throw new Error(
        'Invalid configuration:\n  DATABASE_URL: must be an mssql:// URL with DB_ENGINE=mssql, and a postgres:// one otherwise',
      );
    // The API and the worker run in separate containers: only Blob Storage is shared.
    if (d.NODE_ENV === 'production' && d.EXPORT_STORAGE !== 'blob')
      throw new Error('Invalid configuration:\n  EXPORT_STORAGE: must be blob in production');
    if (d.EXPORT_STORAGE === 'blob' && !d.EXPORT_BLOB_URL && !d.AZURE_STORAGE_CONNECTION_STRING)
      throw new Error(
        'Invalid configuration:\n  EXPORT_BLOB_URL or AZURE_STORAGE_CONNECTION_STRING: required when EXPORT_STORAGE=blob',
      );
    // The deployment's Microsoft sign-in comes whole, or not at all.
    const deployment = {
      SSO_DEFAULT_ORG: d.SSO_DEFAULT_ORG,
      ENTRA_TENANT_ID: d.ENTRA_TENANT_ID,
      ENTRA_CLIENT_ID: d.ENTRA_CLIENT_ID,
      ENTRA_CLIENT_SECRET: d.ENTRA_CLIENT_SECRET,
      ENTRA_REDIRECT_URI: d.ENTRA_REDIRECT_URI,
    };
    const missing = Object.entries(deployment)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length && missing.length < Object.keys(deployment).length)
      throw new Error(
        `Invalid configuration:\n  ${missing.join(', ')}: required with ${Object.keys(deployment)
          .filter((k) => !missing.includes(k))
          .join(', ')}`,
      );
    // Without passwords and without the deployment's directory nobody could sign in.
    if (!d.PASSWORD_LOGIN && missing.length)
      throw new Error(
        'Invalid configuration:\n  PASSWORD_LOGIN=false: requires SSO_DEFAULT_ORG, ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and ENTRA_REDIRECT_URI',
      );
  }
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}

/** Tests change env between apps; production never calls this. */
export function resetConfigCache(): void {
  cached = null;
}

export const CONFIG = Symbol('CONFIG');
