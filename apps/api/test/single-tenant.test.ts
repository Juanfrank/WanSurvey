import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import type { Engine } from '../src/db/engine.js';
import { pickSingleTenant, SingleTenantError, Tenancy } from '../src/tenants/tenancy.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'mssql://u:p@localhost:1433/db',
  ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
} as NodeJS.ProcessEnv;

describe('SINGLE_TENANT', () => {
  it('is off unless the deployment turns it on', () => {
    expect(loadConfig(base).SINGLE_TENANT).toBe(false);
    expect(loadConfig({ ...base, SINGLE_TENANT: '' }).SINGLE_TENANT).toBe(false);
    expect(loadConfig({ ...base, SINGLE_TENANT: 'false' }).SINGLE_TENANT).toBe(false);
    expect(loadConfig({ ...base, SINGLE_TENANT: 'true' }).SINGLE_TENANT).toBe(true);
    expect(() => loadConfig({ ...base, SINGLE_TENANT: 'yes' })).toThrow(/SINGLE_TENANT/);
  });
});

describe('the organisation a single-tenant installation serves', () => {
  const A = '0190A1B2-0000-7000-8000-000000000001';
  const B = '0190a1b2-0000-7000-8000-000000000002';

  it('none yet on a new installation', () => {
    expect(pickSingleTenant([])).toBeNull();
  });

  it('the only one', () => {
    expect(pickSingleTenant([A])).toBe(A.toLowerCase());
  });

  it('with several, the start fails and says why', () => {
    expect(() => pickSingleTenant([A, B])).toThrow(SingleTenantError);
    expect(() => pickSingleTenant([A, B])).toThrow(
      'SINGLE_TENANT=true, but the database has 2 organisations: the mode serves one; turn it off (SINGLE_TENANT=false) or keep a single organisation in the database',
    );
  });
});

describe('Tenancy', () => {
  const A = '0190a1b2-0000-7000-8000-00000000000a';
  const B = '0190a1b2-0000-7000-8000-00000000000b';
  /** A Tenancy over a database whose organisations are `orgs` at each moment. */
  const tenancy = (single: boolean, orgs: { now: string[] }) =>
    new Tenancy(
      { SINGLE_TENANT: single } as AppConfig,
      { allTenantIds: async () => orgs.now } as unknown as Engine,
    );

  it('in the default mode allows every organisation and refuses nothing', async () => {
    const t = tenancy(false, { now: [A, B] });
    await t.onApplicationBootstrap();
    expect(await t.tenantId()).toBeNull();
    expect(await t.allows(B)).toBe(true);
    expect(() => t.refuseIfSingle()).not.toThrow();
  });

  it('refuses the routes about several organisations with 404', () => {
    const t = tenancy(true, { now: [A] });
    expect(() => t.refuseIfSingle()).toThrow(
      expect.objectContaining({
        status: 404,
        response: expect.objectContaining({ code: 'SINGLE_TENANT' }),
      }),
    );
  });

  it('stops the start with several organisations', async () => {
    await expect(tenancy(true, { now: [A, B] }).onApplicationBootstrap()).rejects.toThrow(
      SingleTenantError,
    );
  });

  it('serves the first organisation of a new installation, and keeps it', async () => {
    const orgs = { now: [] as string[] };
    const t = tenancy(true, orgs);
    await t.onApplicationBootstrap();
    expect(await t.tenantId()).toBeNull();
    expect(await t.allows(A)).toBe(false);
    orgs.now = [A.toUpperCase()];
    expect(await t.allows(A)).toBe(true);
    orgs.now = [A, B];
    expect(await t.tenantId()).toBe(A);
    expect(await t.allows(B)).toBe(false);
  });

  it('answers 503, without guessing, when several appear at once after an empty start', async () => {
    const orgs = { now: [] as string[] };
    const t = tenancy(true, orgs);
    await t.onApplicationBootstrap();
    orgs.now = [A, B];
    await expect(t.tenantId()).rejects.toThrow(
      expect.objectContaining({
        status: 503,
        response: expect.objectContaining({ code: 'SINGLE_TENANT_AMBIGUOUS' }),
      }),
    );
  });
});
