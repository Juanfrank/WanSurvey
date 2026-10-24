import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
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
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  /** Public base URL of this API; Microsoft redirects back to {API_PUBLIC_URL}/api/v1/auth/sso/callback. */
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
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
  SSO_DEFAULT_ORG: z.string().min(1).max(64).optional(),
  /**
   * Microsoft sign-in of SSO_DEFAULT_ORG from the deployment (App Service settings), used
   * instead of the organisation's own settings: with password sign-in off, nobody could sign
   * in to configure it otherwise. The secret should come from Key Vault.
   */
  ENTRA_TENANT_ID: z.string().min(1).max(100).optional(),
  ENTRA_CLIENT_ID: z.string().min(1).max(100).optional(),
  ENTRA_CLIENT_SECRET: z.string().min(1).max(500).optional(),
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
  /** Proxies in front of the API (load balancer, nginx…), for the client address. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  /**
   * Jobs a worker process runs at once: light ones (e-mail, figures, privacy) and heavy ones
   * (exports, which hold a file in memory). Keep the sum within DB_WORKER_POOL_MAX.
   */
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  HEAVY_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  /**
   * When the worker refreshes the analysis model (schema bi), as cron in UTC (every 6 hours;
   * nothing runs when no data changed); 'off' never.
   */
  BI_REFRESH_CRON: z.string().trim().min(1).default('40 */6 * * *'),
  /** Days an export's file is kept before it is deleted (the request stays, as expired); 0 keeps them. */
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
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
