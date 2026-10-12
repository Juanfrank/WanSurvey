import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** Connection as the restricted application role (RLS enforced). */
  DATABASE_URL: z.string().url(),
  /** Owner/superuser connection, used only for migrations and seeding. */
  DATABASE_ADMIN_URL: z.string().url().optional(),
  /** 32-byte key (base64) for field-level encryption of secrets such as TOTP seeds. */
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  /** Public base URL of this API; Microsoft redirects back to {API_PUBLIC_URL}/api/v1/auth/sso/callback. */
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /** Microsoft identity platform host; overridable for tests or sovereign clouds. */
  ENTRA_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
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
