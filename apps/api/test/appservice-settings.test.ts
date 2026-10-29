import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ROOT = join(import.meta.dirname, '../../..');
type Setting = { name: string; value: string; slotSetting: boolean };
const template = (env: string) =>
  JSON.parse(
    readFileSync(join(ROOT, `appconfig/appservice.${env}.template.json`), 'utf8'),
  ) as Setting[];

/** What a person would write in place of each `<…>`: valid values of the right shape. */
const FILLED: Record<string, string> = {
  DATABASE_URL: 'postgres://wansurvey_app:x@db.example.org:5432/wansurvey?sslmode=require',
  DATABASE_ADMIN_URL: 'postgres://owner:x@db.example.org:5432/wansurvey?sslmode=require',
  APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  PUBLIC_WEB_URL: 'https://encuestas.example.org',
  API_PUBLIC_URL: 'https://encuestas.example.org',
  SMTP_URL: 'smtps://user:pass@smtp.example.org:465',
  MAIL_FROM: 'WanSurvey <encuestas@example.org>',
  EXPORT_BLOB_URL: 'https://account.blob.core.windows.net/exports',
  AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
  SSO_DEFAULT_ORG: 'pj',
  ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000002',
  ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000003',
  ENTRA_CLIENT_SECRET: 'secret',
  ENTRA_ALLOWED_DOMAINS: 'example.org',
};
const placeholder = (v: string) => v.startsWith('<') && v.endsWith('>');

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
      const blanks = settings.filter((s) => placeholder(s.value)).map((s) => s.name);
      expect(blanks.filter((n) => !FILLED[n])).toEqual([]);
      const env_ = Object.fromEntries(
        settings.map((s) => [s.name, placeholder(s.value) ? FILLED[s.name]! : s.value]),
      ) as NodeJS.ProcessEnv;
      const config = loadConfig(env_);
      expect(config.NODE_ENV).toBe(env);
      expect(config.EXPORT_STORAGE).toBe('blob');
      expect(config.PASSWORD_LOGIN).toBe(env === 'development');
      // The API serves the web app: one address for both.
      expect(config.API_PUBLIC_URL).toBe(config.PUBLIC_WEB_URL);
    });

  it('API_PUBLIC_URL: PUBLIC_WEB_URL when left out, localhost:3000 locally, or as given', () => {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'API_PUBLIC_URL' && k !== 'PUBLIC_WEB_URL'),
    ) as NodeJS.ProcessEnv;
    expect(loadConfig(base).API_PUBLIC_URL).toBe('http://localhost:3000');
    expect(loadConfig({ ...base, PUBLIC_WEB_URL: 'https://a.example.org' }).API_PUBLIC_URL).toBe(
      'https://a.example.org',
    );
    expect(
      loadConfig({
        ...base,
        PUBLIC_WEB_URL: 'https://a.example.org',
        API_PUBLIC_URL: 'https://api.example.org',
      }).API_PUBLIC_URL,
    ).toBe('https://api.example.org');
  });

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
