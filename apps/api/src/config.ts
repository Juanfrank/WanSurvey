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

/**
 * Names that changed so that the same concept has the same name in every app. An old name in
 * the environment stops the app and says which name replaces it: a deployment not renamed would
 * otherwise start with the setting silently missing (no Microsoft sign-in, local files).
 */
export const RENAMED_VARIABLES: Record<string, string> = {
  PUBLIC_WEB_URL: 'PUBLIC_URL',
  APP_ENCRYPTION_KEY: 'ENCRYPTION_KEY',
  EXPORT_DIR: 'DATA_DIR',
  EXPORT_BLOB_CONTAINER: 'AZURE_STORAGE_CONTAINER',
  // EXPORT_BLOB_URL (https://<account>.blob.core.windows.net/<container>) is split in two.
  EXPORT_BLOB_URL: 'AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_CONTAINER',
  // The organisation is found from the e-mail's domain: nothing replaces these.
  SSO_DEFAULT_ORG: 'nothing (the organisation is found from the e-mail domain; docs/sso-entra.md)',
  ENTRA_ENFORCE: 'nothing (each organisation requires Microsoft in its own settings)',
};

/** Settings that are secrets, and what a placeholder looks like. */
const SECRET_SETTINGS = new Set([
  'ENCRYPTION_KEY',
  'ENTRA_CLIENT_SECRET',
  'MAIL_WEBHOOK_SECRET',
  'SMTP_URL',
  'SMS_CONNECTION_STRING',
  'VAPID_PRIVATE_KEY',
  'SMS_WEBHOOK_SECRET',
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'DATABASE_READONLY_URL',
]);
const EXAMPLE_SECRET = /(^|[:/@=])(dev-|change-me|admin1234)|change-me/i;

export const SSO_CALLBACK_PATH = '/api/auth/entra/callback';

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
  /** `mssql://…` as the restricted application user (the security policy applies to it). */
  DATABASE_URL: z.string().url(),
  /** `mssql://…` as the database owner, used only for migrations and seeding. */
  DATABASE_ADMIN_URL: z.string().url().optional(),
  /**
   * The schema of the application's tables, procedures and views (default `dbo`). The application
   * itself names none: its database user has this schema as its default, which the migrations set,
   * so choose it before the first migration and keep it.
   */
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Letters, digits and underscores')
    .default('dbo'),
  /**
   * `mssql://…` for a read-only user of the analysis model (schema `bi`): the migrations make it, with
   * the name and password given here, and it sees nothing else. Optional.
   */
  DATABASE_READONLY_URL: z.string().url().optional(),
  /**
   * 'false': the DBA makes the SQL users (any kind: contained, or mapped from a login) and the
   * migrations only make the schema and the tables and grant the permissions to them. The users
   * must exist, with the application's schema as default schema; their passwords are not needed
   * here (the URL of the application still has the name). Nothing about users or database
   * containment is created or changed. Default 'true': the migrations make them (02-migrate.md).
   */
  DATABASE_MANAGE_USERS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Database connections per process (API, worker). Size them so that, over every instance of
   * both, they stay under what the database allows (Azure SQL: the limit of the service tier).
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DB_WORKER_POOL_MAX: z.coerce.number().int().min(1).max(200).default(5),
  /** A request's statement and lock waits are cut after these (ms); jobs get a longer statement time. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  DB_WORKER_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(600_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).default(5_000),
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
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64'),
  /**
   * The app's public address: links in e-mails and the Microsoft redirect URI
   * ({PUBLIC_URL}/api/auth/entra/callback). The API answers /api on this same address:
   * itself from the zip, through Vite's proxy in development.
   */
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  /**
   * The organisation that runs this installation, for the About and Privacy pages: who answers
   * for the personal data (the controller) and where people write about it. Left out, the pages
   * say the installation's administrator holds them.
   */
  ORG_NAME: z.string().max(200).optional(),
  PRIVACY_CONTACT: z.string().max(200).optional(),
  /** Who wrote the application, shown on the About page (not the organisation that runs it). */
  APP_AUTHOR: z.string().trim().max(200).optional(),
  /** Who holds the rights over the application (titular), shown on the About page. */
  APP_HOLDER: z.string().trim().max(200).optional(),
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
  /**
   * Whether organisations may create the account (no role) of whoever first signs in with Microsoft
   * from their domains. Each organisation chooses on its own Organisation page (default: yes);
   * 'false' here forbids it for all of them: only people already added or invited get in, anyone
   * else is refused with `not_provisioned`.
   */
  ENTRA_AUTO_PROVISION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * The deployment's Microsoft directory (App Service settings), used by every organisation
   * that turns Microsoft sign-in on instead of a directory of its own: the organisation is found
   * from the e-mail's domain. ENTRA_CLIENT_SECRET is the secret itself or a Key Vault reference
   * (`@Microsoft.KeyVault(SecretUri=...)`, resolved by App Service, or by the app elsewhere).
   */
  ENTRA_TENANT_ID: optionalGuid('Directory (tenant) ID, a GUID'),
  ENTRA_CLIENT_ID: optionalGuid('Application (client) ID, a GUID'),
  ENTRA_CLIENT_SECRET: optionalText(500),
  /**
   * The redirect URI registered in the Entra app, exactly: {public address}/api/auth/entra/callback
   * (the same path in every app). Without the deployment's Microsoft sign-in, organisations'
   * own directories use PUBLIC_URL + that path.
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
   * E-mail domains, comma-separated, whose people may sign in through ENTRA_TENANT_ID (each
   * organisation lists its own as well; both must hold). Empty: the organisations' domains alone.
   */
  ENTRA_ALLOWED_DOMAINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  /**
   * The user principal name (UPN, as in Microsoft Entra ID) of the first administrator: on a new
   * installation with no organisation, one is created from the UPN's domain with that person as
   * its owner, and their first Microsoft sign-in activates the account (no password). It needs the
   * deployment's directory (ENTRA_*). See db/initial-admin.ts.
   */
  INITIAL_ADMIN_USER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/, 'A user principal name, such as ana@agency.org')
      .optional(),
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
  /**
   * Lets webhooks go to http addresses and private networks (tests, local development). Never in
   * production: it would let an organisation make the server call its own network.
   */
  WEBHOOK_ALLOW_PRIVATE_URLS: z.enum(['true', 'false']).default('false'),
  /** Web notifications (Web Push): the VAPID key pair (`npm run vapid` makes one) and a contact. */
  VAPID_PUBLIC_KEY: z.string().min(80).max(100).optional(),
  VAPID_PRIVATE_KEY: z.string().min(40).max(60).optional(),
  /** mailto: or https: address of whoever runs the service, shown to the push services. */
  VAPID_SUBJECT: z.string().max(200).optional(),
  /** How SMS leaves: logged, written as files (development), or Azure Communication Services. */
  SMS_PROVIDER: z.enum(['console', 'file', 'acs']).default('console'),
  /** Folder for SMS_PROVIDER=file (one JSON file per message). */
  SMS_OUTBOX_DIR: z.string().optional(),
  /** Azure Communication Services: endpoint=https://….communication.azure.com/;accesskey=… */
  SMS_CONNECTION_STRING: z.string().optional(),
  /** Sender number or short code the provider resource owns (SMS_PROVIDER=acs). */
  SMS_FROM: z.string().optional(),
  /** Price of one message segment, in the organisation's money, for the cost shown before sending. */
  SMS_PRICE_PER_SEGMENT: z.coerce.number().min(0).default(0),
  /** A wave to more recipients than this asks for a second confirmation before it is sent. */
  SMS_CONFIRM_ABOVE: z.coerce.number().int().min(0).default(500),
  /** Shared secret the SMS provider sends in `x-webhook-secret` with replies (STOP). */
  SMS_WEBHOOK_SECRET: z.string().min(16).optional(),
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
  /** 'local': the directory for files (created if missing). */
  DATA_DIR: optionalText(1000),
  /**
   * 'blob': the storage account (https://<account>.blob.core.windows.net), reached with the
   * app's managed identity (AZURE_CLIENT_ID for a user-assigned one). Both account and
   * container, or neither.
   */
  AZURE_STORAGE_ACCOUNT_NAME: optionalText(24),
  /** The container; with a connection string (Azurite) alone, 'exports' if not given. */
  AZURE_STORAGE_CONTAINER: optionalText(63),
  /** Container of the interview recordings in the same account (private, never signed links). */
  AZURE_STORAGE_AUDIO_CONTAINER: z.string().min(3).max(63).default('interview-audio'),
  /** The user-assigned managed identity's client id (App Service sets no default one). */
  AZURE_CLIENT_ID: optionalText(100),
  /** …or a connection string (Azurite in development and tests). */
  AZURE_STORAGE_CONNECTION_STRING: optionalText(2000),
  /** How often the e-mail dispatcher runs (ms); 0 turns it off. */
  DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Optional: OpenTelemetry/Sentry are wired only when configured. */
  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});
/** Every setting the app reads, for the checks that the templates and examples list them all. */
export const CONFIG_KEYS = Object.keys(Env.shape);
export type AppConfig = z.infer<typeof Env>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const former = Object.keys(RENAMED_VARIABLES).filter(
    (k) => env[k] !== undefined && env[k] !== '',
  );
  if (former.length)
    throw new Error(
      `Invalid configuration:\n  ${former.map((k) => `${k}: removed or renamed, see: ${RENAMED_VARIABLES[k]}`).join('\n  ')}`,
    );
  // App Service keeps a setting that was left empty: it counts as not set.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = Env.safeParse(set);
  if (parsed.success && parsed.data.GEOCODER === 'nominatim' && !parsed.data.GEOCODER_EMAIL) {
    throw new Error('Invalid configuration:\n  GEOCODER_EMAIL: required when GEOCODER=nominatim');
  }
  if (parsed.success && parsed.data.MAILER === 'file' && !parsed.data.MAIL_OUTBOX_DIR)
    throw new Error('Invalid configuration:\n  MAIL_OUTBOX_DIR: required when MAILER=file');
  if (parsed.success && parsed.data.MAILER === 'smtp' && !parsed.data.SMTP_URL)
    throw new Error('Invalid configuration:\n  SMTP_URL: required when MAILER=smtp');
  if (parsed.success) {
    const d = parsed.data;
    if (!/^mssql:/.test(d.DATABASE_URL))
      throw new Error('Invalid configuration:\n  DATABASE_URL: must be an mssql:// URL');
    if (d.DATABASE_ADMIN_URL && !/^mssql:/.test(d.DATABASE_ADMIN_URL))
      throw new Error('Invalid configuration:\n  DATABASE_ADMIN_URL: must be an mssql:// URL');
    // The API and the worker run in separate containers: only Blob Storage is shared.
    if (d.NODE_ENV === 'production' && d.EXPORT_STORAGE !== 'blob')
      throw new Error('Invalid configuration:\n  EXPORT_STORAGE: must be blob in production');
    if (d.NODE_ENV === 'production' && d.WEBHOOK_ALLOW_PRIVATE_URLS === 'true')
      throw new Error(
        'Invalid configuration:\n  WEBHOOK_ALLOW_PRIVATE_URLS: must not be true in production',
      );
    if (!!d.VAPID_PUBLIC_KEY !== !!d.VAPID_PRIVATE_KEY || (d.VAPID_PUBLIC_KEY && !d.VAPID_SUBJECT))
      throw new Error(
        'Invalid configuration:\n  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT: all three or none',
      );
    if (d.SMS_PROVIDER === 'acs' && (!d.SMS_CONNECTION_STRING || !d.SMS_FROM))
      throw new Error(
        'Invalid configuration:\n  SMS_CONNECTION_STRING and SMS_FROM: required when SMS_PROVIDER=acs',
      );
    if (d.SMS_PROVIDER === 'file' && !d.SMS_OUTBOX_DIR)
      throw new Error('Invalid configuration:\n  SMS_OUTBOX_DIR: required when SMS_PROVIDER=file');
    if (d.AZURE_STORAGE_ACCOUNT_NAME && !d.AZURE_STORAGE_CONTAINER)
      throw new Error(
        'Invalid configuration:\n  AZURE_STORAGE_CONTAINER: required with AZURE_STORAGE_ACCOUNT_NAME (both or neither)',
      );
    if (
      d.AZURE_STORAGE_CONTAINER &&
      !d.AZURE_STORAGE_ACCOUNT_NAME &&
      !d.AZURE_STORAGE_CONNECTION_STRING
    )
      throw new Error(
        'Invalid configuration:\n  AZURE_STORAGE_ACCOUNT_NAME: required with AZURE_STORAGE_CONTAINER (both or neither)',
      );
    if (
      d.EXPORT_STORAGE === 'blob' &&
      !d.AZURE_STORAGE_ACCOUNT_NAME &&
      !d.AZURE_STORAGE_CONNECTION_STRING
    )
      throw new Error(
        'Invalid configuration:\n  AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_CONTAINER (or AZURE_STORAGE_CONNECTION_STRING): required when EXPORT_STORAGE=blob',
      );
    if (d.NODE_ENV === 'production') {
      const examples = Object.entries(d)
        .filter(
          ([k, v]) => SECRET_SETTINGS.has(k) && typeof v === 'string' && EXAMPLE_SECRET.test(v),
        )
        .map(([k]) => k);
      if (examples.length)
        throw new Error(
          `Invalid configuration:\n  ${examples.join(', ')}: still has an example value; use a real secret in production`,
        );
    }
    // The deployment's Microsoft sign-in comes whole, or not at all.
    const deployment = {
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
    // The first administrator signs in with Microsoft, through the deployment's directory.
    if (d.INITIAL_ADMIN_USER) {
      if (missing.length)
        throw new Error(
          'Invalid configuration:\n  INITIAL_ADMIN_USER: requires ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and ENTRA_REDIRECT_URI (the administrator signs in with Microsoft)',
        );
      const domain = d.INITIAL_ADMIN_USER.slice(d.INITIAL_ADMIN_USER.lastIndexOf('@') + 1);
      if (d.ENTRA_ALLOWED_DOMAINS.length && !d.ENTRA_ALLOWED_DOMAINS.includes(domain))
        throw new Error(
          `Invalid configuration:\n  INITIAL_ADMIN_USER: the domain ${domain} is not in ENTRA_ALLOWED_DOMAINS`,
        );
    }
    // Without passwords and without the deployment's directory nobody could sign in.
    if (!d.PASSWORD_LOGIN && missing.length)
      throw new Error(
        'Invalid configuration:\n  PASSWORD_LOGIN=false: requires ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and ENTRA_REDIRECT_URI',
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
