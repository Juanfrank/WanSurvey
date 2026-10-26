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
  REDIS_URL: 'rediss://:key@cache.example.org:6380',
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
 * filled in, each starts the app in its mode, and production has every setting Bicep sets.
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
    });

  it('production has every setting main.bicep sets', () => {
    const bicep = readFileSync(join(ROOT, 'infra/azure/main.bicep'), 'utf8');
    // From each block's first line to its closing line.
    const block = (start: string, end: string) => {
      const from = bicep.indexOf(start);
      return bicep.slice(from, bicep.indexOf(end, from));
    };
    const keys = [
      ...block('var entraSettings', '\n    }').matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm),
      ...block('var settings = union(', '\n)').matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm),
    ].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    const names = new Set(template('production').map((s) => s.name));
    expect([...keys, 'AZURE_CLIENT_ID'].filter((k) => !names.has(k))).toEqual([]);
  });
});
