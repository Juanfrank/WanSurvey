import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetConfigCache } from '../../src/config.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { MemoryMailer } from '../../src/mail/mailer.js';
import { ADMIN_URL, APP_URL, configured } from './harness.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The sign-in page of an installation for one organisation (SINGLE_TENANT) shows that
 * organisation's logo and colours: a public route gives them, and nothing else. On a database of
 * its own, as the single-tenant tests (the number of organisations matters).
 */
describe.skipIf(!configured)('SQL Server: the organisation’s look before signing in', () => {
  const name = `ws_look_${Date.now().toString(36)}`;
  const at = (url: string, database: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const master = createMssqlDb<Record<string, never>>(at(ADMIN_URL ?? 'mssql://x@y/z', 'master'), {
    max: 1,
  });
  const adminUrl = ADMIN_URL ? at(ADMIN_URL, name) : '';
  const appUrl = APP_URL ? at(APP_URL, name) : '';
  let owner: ReturnType<typeof createMssqlDb<Record<string, never>>>;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SINGLE_TENANT'];
  const apps: INestApplication[] = [];

  async function start() {
    process.env.SINGLE_TENANT = 'true';
    resetConfigCache();
    const made = await createApp({ mailer: new MemoryMailer() });
    await made.init();
    apps.push(made);
    return request(made.getHttpServer());
  }

  beforeAll(async () => {
    await sql.raw(`CREATE DATABASE [${name}]`).execute(master);
    await runMssqlMigrations(adminUrl, appUrl);
    owner = createMssqlDb<Record<string, never>>(adminUrl, { max: 2 });
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { DATABASE_URL: appUrl, DATABASE_ADMIN_URL: adminUrl });
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });
  afterAll(async () => {
    await owner.destroy();
    await sql
      .raw(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
      .execute(master);
    await sql.raw(`DROP DATABASE [${name}]`).execute(master);
    await master.destroy();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    resetConfigCache();
  });

  it('gives the interface as it ships while there is no organisation, then its logo and colours only', async () => {
    const api = await start();
    const empty = await api.get('/api/v1/public/org-look').expect(200);
    expect(empty.body).toEqual({ theme: { default: 'system', accent: 'brand' }, logo: null });
    expect((await api.get('/api/v1/public/org-look/logo')).status).toBe(404);

    // The organisation appears, with a theme and a logo (as its owner would set them).
    const id = randomUUID();
    const theme = { default: 'dark', accent: 'brand', primary: '#7a1f5c', appLogo: 'sub' };
    await sql`INSERT INTO tenants (id, name, slug, branding, settings, logo_alt, logo_updated_at)
              VALUES (${id}, 'Instituto Privado', 'only', ${JSON.stringify({ theme, secret: 'x' })},
                      ${JSON.stringify({ defaultLanguage: 'es' })}, 'Instituto Demo', SYSDATETIMEOFFSET())`.execute(
      owner,
    );
    await sql`INSERT INTO tenant_logos (tenant_id, content_type, image)
              VALUES (${id}, 'image/png', ${PNG})`.execute(owner);

    const look = await api.get('/api/v1/public/org-look').expect(200);
    // Nothing private: no name, slug, settings or other branding keys.
    expect(Object.keys(look.body).sort()).toEqual(['logo', 'theme']);
    expect(look.body.theme).toEqual(theme);
    expect(look.body.logo).toEqual({
      url: expect.stringMatching(/^\/api\/v1\/public\/org-look\/logo\?v=\d+$/),
      alt: 'Instituto Demo',
    });
    expect(JSON.stringify(look.body)).not.toContain('Instituto Privado');
    const img = await api.get(look.body.logo.url as string).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);
  });
});
