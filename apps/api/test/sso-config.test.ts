import { describe, expect, it } from 'vitest';
import { SsoConfigs } from '../src/auth/sso-config.js';
import type { AppConfig } from '../src/config.js';
import type { SsoPublicConfig } from '../src/db/common.js';
import type { Engine } from '../src/db/engine.js';
import { LocalBus } from '../src/jobs/bus.js';

const config = { SSO_DEFAULT_ORG: undefined, ENTRA_ALLOWED_DOMAINS: [] } as unknown as AppConfig;
const row = (clientId: string): SsoPublicConfig => ({
  tenantId: 't1',
  slug: 'org',
  entraTenantId: 'dir',
  clientId,
  enabled: true,
});

/** A database whose answers the test sets, counting the reads. */
function fakeDatabase() {
  const db = {
    clientId: 'old',
    reads: 0,
    slugs: new Set(['org']),
    /** Holds the next read until released, to change the settings in the middle of it. */
    hold: null as Promise<void> | null,
    async ssoConfigBySlug(slug: string) {
      db.reads++;
      const answer = db.slugs.has(slug) ? row(db.clientId) : null;
      if (db.hold) await db.hold;
      return answer;
    },
    async tenantIdBySlug(slug: string) {
      db.reads++;
      return db.slugs.has(slug) ? 't1' : null;
    },
  };
  return db;
}

describe('Microsoft sign-in settings cache', () => {
  it('forgets an organisation in every process once its settings are saved', async () => {
    const bus = new LocalBus();
    const db = fakeDatabase();
    const a = new SsoConfigs(config, bus, { sql: db } as unknown as Engine);
    const b = new SsoConfigs(config, bus, { sql: db } as unknown as Engine);
    expect((await b.startBySlug('org'))?.clientId).toBe('old');
    db.clientId = 'new';
    expect((await b.startBySlug('org'))?.clientId).toBe('old'); // cached
    await a.changed('t1');
    expect((await b.startBySlug('org'))?.clientId).toBe('new');
  });

  it('does not keep a read that began before a change', async () => {
    const db = fakeDatabase();
    const c = new SsoConfigs(config, new LocalBus(), { sql: db } as unknown as Engine);
    let release!: () => void;
    db.hold = new Promise((r) => (release = r));
    const reading = c.startBySlug('org'); // reads the old row, then waits
    await c.changed('t1');
    db.clientId = 'new';
    release();
    expect((await reading)?.clientId).toBe('old');
    db.hold = null;
    expect((await c.startBySlug('org'))?.clientId).toBe('new');
  });

  it('keeps no unknown slug', async () => {
    const db = fakeDatabase();
    const c = new SsoConfigs(config, new LocalBus(), { sql: db } as unknown as Engine);
    expect(await c.tenantIdBySlug('nope')).toBeNull();
    db.slugs.add('nope'); // created afterwards: found at once
    expect(await c.tenantIdBySlug('nope')).toBe('t1');
    const before = db.reads;
    await c.tenantIdBySlug('nope');
    expect(db.reads).toBe(before);
  });
});
