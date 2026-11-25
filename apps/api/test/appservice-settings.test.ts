import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, RENAMED_VARIABLES, loadConfig } from '../src/config.js';

const ROOT = join(import.meta.dirname, '../../..');
type Setting = { name: string; value: string; slotSetting: boolean };
const template = (env: string) =>
  JSON.parse(
    readFileSync(join(ROOT, `appconfig/app-settings.${env}.template.json`), 'utf8'),
  ) as Setting[];

/** What a person would write in place of each `<…>`: valid values of the right shape. */
const FILLED: Record<string, string> = {
  DATABASE_URL: 'mssql://wansurvey_app:x@db.example.org:1433/wansurvey',
  DATABASE_ADMIN_URL: 'mssql://owner:x@db.example.org:1433/wansurvey',
  ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  PUBLIC_URL: 'https://encuestas.example.org',
  SMTP_URL: 'smtps://user:pass@smtp.example.org:465',
  MAIL_FROM: 'WanSurvey <encuestas@example.org>',
  AZURE_STORAGE_ACCOUNT_NAME: 'account',
  AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
  ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000002',
  ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000003',
  ENTRA_CLIENT_SECRET: 'secret',
  ENTRA_REDIRECT_URI: 'https://encuestas.example.org/api/auth/entra/callback',
  ENTRA_ALLOWED_DOMAINS: 'example.org',
  INITIAL_ADMIN_USER: 'ana@example.org',
  HEALTH_ALLOWED_IPS: '169.254.0.0/16,127.0.0.1',
  MAIL_WEBHOOK_SECRET: '0123456789abcdef0123',
};
const placeholder = (v: string) => v.startsWith('<') && v.endsWith('>');
const TAGGED = /^<(REQUIRED|OPTIONAL|CONDITIONAL) — /;

/**
 * The App Service settings templates in appconfig/ (pasted into "Advanced edit" by hand):
 * filled in, each starts the app in its mode, as App Service runs it from a zip (one Node
 * process: no Redis, no nginx, no containers).
 */
describe('App Service settings templates', () => {
  for (const env of ['development', 'production'] as const)
    it(`${env}: unique names, and the app starts with the blanks filled in`, () => {
      const settings = template(env);
      const names = settings.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
      for (const s of settings) {
        expect(typeof s.value).toBe('string');
        expect(s.slotSetting).toBe(false);
      }
      // Every placeholder says if the setting is required, optional or conditional.
      expect(settings.filter((s) => placeholder(s.value) && !TAGGED.test(s.value))).toEqual([]);
      const required = settings.filter((s) => s.value.startsWith('<REQUIRED'));
      expect(required.filter((s) => !FILLED[s.name]).map((s) => s.name)).toEqual([]);
      // The required ones and the conditional ones the mode needs get a value; the rest are left out.
      const env_ = Object.fromEntries(
        settings
          .filter((s) => !placeholder(s.value) || FILLED[s.name] !== undefined)
          .map((s) => [s.name, placeholder(s.value) ? FILLED[s.name]! : s.value]),
      ) as NodeJS.ProcessEnv;
      const config = loadConfig(env_);
      expect(config.NODE_ENV).toBe(env);
      expect(config.EXPORT_STORAGE).toBe('blob');
      expect(config.PASSWORD_LOGIN).toBe(env === 'development');
    });

  for (const env of ['development', 'production'] as const) {
    it(`${env}: a template pasted as it is stops on the required settings, and ignores the optional ones`, () => {
      const settings = template(env);
      const asIs = Object.fromEntries(settings.map((s) => [s.name, s.value])) as NodeJS.ProcessEnv;
      const required = settings.filter((s) => s.value.startsWith('<REQUIRED')).map((s) => s.name);
      expect(required.length).toBeGreaterThan(2);
      try {
        loadConfig(asIs);
        expect.unreachable();
      } catch (e) {
        for (const n of required)
          expect((e as Error).message).toContain(`${n}: still the placeholder`);
      }
      // With the required ones filled, whatever is optional or conditional and left as it was is not set.
      const filled = { ...asIs };
      for (const n of required) filled[n] = FILLED[n]!;
      for (const s of settings.filter((x) => x.value.startsWith('<CONDITIONAL') && FILLED[x.name]))
        filled[s.name] = FILLED[s.name]!;
      const config = loadConfig(filled);
      expect(config.ORG_NAME).toBeUndefined();
      expect(config.VAPID_PUBLIC_KEY).toBeUndefined();
      expect(config.APPLICATIONINSIGHTS_CONNECTION_STRING).toBeUndefined();
    });
  }

  // What the zip needs, and what only the containers (infra/azure/main.bicep) used.
  const ZIP = ['WEB_DIST', 'DATABASE_ADMIN_URL', 'NODE_OPTIONS', 'WEBSITE_RUN_FROM_PACKAGE'];
  const CONTAINERS = ['REDIS_URL', 'API_UPSTREAM', 'API_PORT', 'WORKER_HEALTH_PORT'];
  for (const env of ['development', 'production'] as const)
    it(`${env}: the settings of the zip, none of the containers'`, () => {
      const settings = new Map(template(env).map((s) => [s.name, s.value]));
      expect(ZIP.filter((k) => !settings.has(k))).toEqual([]);
      expect(CONTAINERS.filter((k) => settings.has(k))).toEqual([]);
      expect(settings.get('WEB_DIST')).toBe('/home/site/wwwroot/public');
      expect(settings.get('TRUST_PROXY_HOPS')).toBe('1');
      expect(settings.get('SCM_DO_BUILD_DURING_DEPLOYMENT')).toBe('false');
    });
});

/**
 * The same settings, listed three times: read by the code (config.ts), in `.env.example` and in
 * the App Service templates. A setting added to one and forgotten in the others is caught here.
 */
describe('settings coherence', () => {
  const PLATFORM = [
    'NODE_OPTIONS',
    'WEBSITE_RUN_FROM_PACKAGE',
    'SCM_DO_BUILD_DURING_DEPLOYMENT',
    'WEBSITE_HEALTHCHECK_MAXPINGFAILURES',
  ];
  // Used by the containers (Redis, the worker's own port): the zip has neither.
  const CONTAINERS_ONLY = ['REDIS_URL', 'WORKER_HEALTH_PORT'];
  const keys = CONFIG_KEYS;

  for (const env of ['development', 'production'] as const)
    it(`${env}: the template lists every setting the code reads, and nothing else`, () => {
      const names = new Set(template(env).map((s) => s.name));
      const expected = keys.filter((k) => !CONTAINERS_ONLY.includes(k));
      expect(expected.filter((k) => !names.has(k))).toEqual([]);
      expect([...names].filter((n) => !keys.includes(n) && !PLATFORM.includes(n))).toEqual([]);
    });

  it('.env.example mentions every setting the code reads, and no former name', () => {
    const text = readFileSync(join(ROOT, 'apps/api/.env.example'), 'utf8');
    const mentioned = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    expect(keys.filter((k) => !mentioned.has(k!))).toEqual([]);
    expect(Object.keys(RENAMED_VARIABLES).filter((k) => mentioned.has(k))).toEqual([]);
  });

  it('no template uses a former name', () => {
    for (const env of ['development', 'production'] as const)
      expect(
        template(env)
          .map((s) => s.name)
          .filter((n) => n in RENAMED_VARIABLES),
      ).toEqual([]);
  });
});
