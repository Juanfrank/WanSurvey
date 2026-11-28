import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import type { Engine } from '../src/db/engine.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  pickSingleTenant,
  SingleTenantError,
  Tenancy,
  type TenantChoice,
} from '../src/tenants/tenancy.js';

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

describe('SINGLE_TENANT_ORG', () => {
  it('is a slug or id, trimmed and lower-cased; empty is unset', () => {
    expect(loadConfig(base).SINGLE_TENANT_ORG).toBeUndefined();
    expect(loadConfig({ ...base, SINGLE_TENANT_ORG: '  ' }).SINGLE_TENANT_ORG).toBeUndefined();
    expect(loadConfig({ ...base, SINGLE_TENANT_ORG: ' Acme ' }).SINGLE_TENANT_ORG).toBe('acme');
  });
});

const org = (id: string, slug: string, daysAgo: number): TenantChoice => ({
  id,
  slug,
  createdAt: new Date(Date.UTC(2026, 0, 31) - daysAgo * 86_400_000),
});

describe('the organisation a single-tenant installation serves', () => {
  const A = '0190A1B2-0000-7000-8000-000000000001';
  const B = '0190a1b2-0000-7000-8000-000000000002';
  const C = '0190a1b2-0000-7000-8000-000000000003';

  it('none yet on a new installation', () => {
    expect(pickSingleTenant([])).toBeNull();
    expect(pickSingleTenant([], 'acme')).toBeNull();
  });

  it('the only one', () => {
    expect(pickSingleTenant([org(A, 'a', 1)])).toBe(A.toLowerCase());
  });

  it('with several and no choice, the oldest by creation (the id breaks a tie)', () => {
    expect(pickSingleTenant([org(B, 'b', 1), org(C, 'c', 9), org(A, 'a', 5)])).toBe(C);
    expect(pickSingleTenant([org(C, 'c', 3), org(B, 'b', 3)])).toBe(B);
  });

  it('the one SINGLE_TENANT_ORG names, by slug or id', () => {
    const all = [org(A, 'a', 9), org(B, 'acme', 1)];
    expect(pickSingleTenant(all, 'acme')).toBe(B);
    expect(pickSingleTenant(all, 'ACME')).toBe(B);
    expect(pickSingleTenant(all, B.toUpperCase())).toBe(B);
    expect(pickSingleTenant(all, A)).toBe(A.toLowerCase());
  });

  it('one the database lacks stops the start and says why', () => {
    expect(() => pickSingleTenant([org(A, 'a', 1)], 'nowhere')).toThrow(SingleTenantError);
    expect(() => pickSingleTenant([org(A, 'a', 1)], 'nowhere')).toThrow(
      'SINGLE_TENANT_ORG=nowhere, but the database has no organisation with that slug or id; set it to the slug or id of an existing organisation, or leave it unset to serve the oldest',
    );
  });
});

describe('Tenancy', () => {
  const A = '0190a1b2-0000-7000-8000-00000000000a';
  const B = '0190a1b2-0000-7000-8000-00000000000b';
  /** A Tenancy over a database whose organisations are `orgs` at each moment. */
  const tenancy = (single: boolean, orgs: { now: TenantChoice[] }, wanted?: string) => {
    const fence: { opens: ((t: string) => Promise<boolean>) | null } = { opens: null };
    const t = new Tenancy(
      { SINGLE_TENANT: single, SINGLE_TENANT_ORG: wanted } as AppConfig,
      {
        everyTenant: async () => orgs.now,
        fence: (f: (t: string) => Promise<boolean>) => (fence.opens = f),
      } as unknown as Engine,
    );
    return Object.assign(t, { fenced: fence });
  };

  it('in the default mode allows every organisation, fences nothing and refuses nothing', async () => {
    const t = tenancy(false, { now: [org(A, 'a', 2), org(B, 'b', 1)] });
    await t.onApplicationBootstrap();
    expect(t.fenced.opens).toBeNull();
    expect(await t.tenantId()).toBeNull();
    expect(await t.allows(B)).toBe(true);
    expect(() => t.refuseIfSingle()).not.toThrow();
  });

  it('refuses the routes about several organisations with 404', () => {
    const t = tenancy(true, { now: [org(A, 'a', 1)] });
    expect(() => t.refuseIfSingle()).toThrow(
      expect.objectContaining({
        status: 404,
        response: expect.objectContaining({ code: 'SINGLE_TENANT' }),
      }),
    );
  });

  it('with several organisations starts, serves the oldest and fences the others', async () => {
    const t = tenancy(true, { now: [org(B, 'b', 1), org(A, 'a', 2)] });
    await t.onApplicationBootstrap();
    expect(await t.tenantId()).toBe(A);
    expect(await t.fenced.opens!(A)).toBe(true);
    expect(await t.fenced.opens!(B)).toBe(false);
  });

  it('serves the one SINGLE_TENANT_ORG names; one the database lacks stops the start', async () => {
    const orgs = { now: [org(A, 'a', 2), org(B, 'bee', 1)] };
    const t = tenancy(true, orgs, 'bee');
    await t.onApplicationBootstrap();
    expect(await t.allows(B)).toBe(true);
    expect(await t.allows(A)).toBe(false);
    await expect(tenancy(true, orgs, 'nowhere').onApplicationBootstrap()).rejects.toThrow(
      SingleTenantError,
    );
  });

  it('serves the first organisation of a new installation, and keeps it', async () => {
    const orgs = { now: [] as TenantChoice[] };
    const t = tenancy(true, orgs);
    await t.onApplicationBootstrap();
    expect(await t.tenantId()).toBeNull();
    expect(await t.allows(A)).toBe(false);
    orgs.now = [org(A.toUpperCase(), 'a', 1)];
    expect(await t.allows(A)).toBe(true);
    orgs.now = [org(B, 'b', 9), org(A, 'a', 1)];
    expect(await t.tenantId()).toBe(A);
    expect(await t.allows(B)).toBe(false);
  });

  it('answers 503 when organisations appear after an empty start but not the one named', async () => {
    const orgs = { now: [] as TenantChoice[] };
    const t = tenancy(true, orgs, 'acme');
    await t.onApplicationBootstrap();
    orgs.now = [org(A, 'a', 1)];
    await expect(t.tenantId()).rejects.toThrow(
      expect.objectContaining({
        status: 503,
        response: expect.objectContaining({ code: 'SINGLE_TENANT_ORG' }),
      }),
    );
    // The fence fails closed meanwhile: nothing is opened.
    expect(await t.fenced.opens!(A)).toBe(false);
    orgs.now = [org(A, 'a', 1), org(B, 'acme', 0)];
    expect(await t.tenantId()).toBe(B);
    expect(await t.fenced.opens!(B)).toBe(true);
  });
});

describe('jobs of a closed organisation', () => {
  const A = '0190a1b2-0000-7000-8000-00000000000a';
  const B = '0190a1b2-0000-7000-8000-00000000000b';
  const config = loadConfig({ ...base, NODE_ENV: 'test' });

  it('are set aside, neither run nor failed; jobs of no organisation run', async () => {
    const engine = { opens: async (t: string) => t === A } as unknown as Engine;
    const jobs = new JobsService(config, 'worker', engine);
    const ran: unknown[] = [];
    jobs.register('x', async (d) => {
      ran.push(d.tenantId ?? 'all');
      return 'done';
    });
    expect(await jobs.run('x', { tenantId: B })).toBeUndefined();
    expect(await jobs.run('x', { tenantId: A })).toBe('done');
    expect(await jobs.run('x', {})).toBe('done');
    // Inline (no Redis), as the API runs them without a worker.
    const inline = new JobsService(config, 'api', engine);
    inline.register('x', async (d) => ran.push(`inline:${String(d.tenantId)}`));
    await inline.enqueue('x', { tenantId: B });
    await inline.enqueue('x', { tenantId: A });
    await inline.drain();
    expect(ran).toEqual([A, 'all', `inline:${A}`]);
    await inline.onModuleDestroy();
    await jobs.onModuleDestroy();
  });

  it('without a fence (the default mode) every job runs', async () => {
    const jobs = new JobsService(config, 'worker', {
      opens: async () => true,
    } as unknown as Engine);
    let n = 0;
    jobs.register('x', async () => ++n);
    await jobs.run('x', { tenantId: B });
    expect(n).toBe(1);
    await jobs.onModuleDestroy();
  });
});
