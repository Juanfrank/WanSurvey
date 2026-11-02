import { describe, expect, it } from 'vitest';
import { loadConfig, RENAMED_VARIABLES } from '../src/config.js';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'mssql://u:p@localhost:1433/db',
  ENCRYPTION_KEY: KEY,
} as NodeJS.ProcessEnv;

describe('configuration names', () => {
  it.each(Object.entries(RENAMED_VARIABLES))('%s stops the app and says: %s', (old, now) => {
    expect(() => loadConfig({ ...base, [old]: 'x' })).toThrow(
      `${old}: removed or renamed, see: ${now}`,
    );
  });

  it('says every former name found', () => {
    expect(() => loadConfig({ ...base, PUBLIC_WEB_URL: 'x', EXPORT_DIR: 'y' })).toThrow(
      /PUBLIC_WEB_URL: removed or renamed, see: PUBLIC_URL\n\s+EXPORT_DIR: removed or renamed, see: DATA_DIR/,
    );
  });

  it('a former name left empty is ignored (App Service keeps empty settings)', () => {
    expect(loadConfig({ ...base, PUBLIC_WEB_URL: '' }).PUBLIC_URL).toBe('http://localhost:5173');
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
