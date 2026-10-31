import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRenamedVariables, loadConfig, RENAMED_VARIABLES } from '../src/config.js';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'mssql://u:p@localhost:1433/db',
  ENCRYPTION_KEY: KEY,
} as NodeJS.ProcessEnv;

describe('configuration names', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a former name as the new one, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ENCRYPTION_KEY: _unused, ...rest } = base;
    const c = loadConfig({
      ...rest,
      APP_ENCRYPTION_KEY: KEY,
      PUBLIC_WEB_URL: 'https://old.example.org',
      EXPORT_DIR: '/tmp/x',
    });
    expect(c.ENCRYPTION_KEY).toBe(KEY);
    expect(c.PUBLIC_URL).toBe('https://old.example.org');
    expect(c.DATA_DIR).toBe('/tmp/x');
    expect(String(warn.mock.calls[0]?.[0])).toContain('APP_ENCRYPTION_KEY is now ENCRYPTION_KEY');
  });

  it('the new name wins over the former one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = loadConfig({
      ...base,
      PUBLIC_URL: 'https://new.example.org',
      PUBLIC_WEB_URL: 'https://old.example.org',
    });
    expect(c.PUBLIC_URL).toBe('https://new.example.org');
  });

  it('splits the former blob URL into account and container', () => {
    const { env } = applyRenamedVariables({
      EXPORT_BLOB_URL: 'https://acct.blob.core.windows.net/exports',
    });
    expect(env.AZURE_STORAGE_ACCOUNT_NAME).toBe('acct');
    expect(env.AZURE_STORAGE_CONTAINER).toBe('exports');
    expect(Object.keys(RENAMED_VARIABLES)).toContain('EXPORT_BLOB_URL');
  });

  it('an empty setting counts as not set', () => {
    expect(loadConfig({ ...base, GEOCODER_EMAIL: '', SMTP_URL: '', PORT: '' }).PORT).toBe(3000);
  });
});

describe('startup checks', () => {
  const prod = {
    ...base,
    NODE_ENV: 'production',
    EXPORT_STORAGE: 'blob',
    AZURE_STORAGE_ACCOUNT_NAME: 'acct',
    AZURE_STORAGE_CONTAINER: 'exports',
  } as NodeJS.ProcessEnv;

  it('storage account and container come together', () => {
    expect(() => loadConfig({ ...prod, AZURE_STORAGE_CONTAINER: '' })).toThrow(
      /AZURE_STORAGE_CONTAINER: required with AZURE_STORAGE_ACCOUNT_NAME/,
    );
    expect(() =>
      loadConfig({ ...base, AZURE_STORAGE_CONTAINER: 'exports', EXPORT_STORAGE: 'local' }),
    ).toThrow(/AZURE_STORAGE_ACCOUNT_NAME: required with AZURE_STORAGE_CONTAINER/);
    expect(loadConfig(prod).AZURE_STORAGE_ACCOUNT_NAME).toBe('acct');
  });

  it('the redirect URI ends in the same path as every app', () => {
    const entra = {
      ...base,
      SSO_DEFAULT_ORG: 'pj',
      ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000002',
      ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000003',
      ENTRA_CLIENT_SECRET: 'secret',
    };
    expect(() =>
      loadConfig({
        ...entra,
        ENTRA_REDIRECT_URI: 'https://x.example.org/api/v1/auth/sso/callback',
      }),
    ).toThrow(/Must end with \/api\/auth\/entra\/callback/);
    expect(
      loadConfig({ ...entra, ENTRA_REDIRECT_URI: 'https://x.example.org/api/auth/entra/callback' })
        .ENTRA_REDIRECT_URI,
    ).toBe('https://x.example.org/api/auth/entra/callback');
  });

  it('refuses an example secret in production', () => {
    expect(() => loadConfig({ ...prod, MAIL_WEBHOOK_SECRET: 'change-me-to-a-long-value' })).toThrow(
      /MAIL_WEBHOOK_SECRET: still has an example value/,
    );
    expect(() =>
      loadConfig({ ...prod, DATABASE_URL: 'mssql://sa:admin1234@db.example.org:1433/x' }),
    ).toThrow(/DATABASE_URL: still has an example value/);
  });
});
