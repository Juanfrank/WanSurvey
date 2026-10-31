import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../../src/config.js';
import { bootstrap, configured, type MssqlTestApp } from './harness.js';

/**
 * The web app served by the API itself (App Service from a zip, no nginx): what nginx did,
 * the same caching and headers, and the client routes answered with the app shell.
 */
describe.skipIf(!configured)('SQL Server: the web app from the API', () => {
  let t: MssqlTestApp;
  const dir = mkdtempSync(join(tmpdir(), 'ws-web-'));

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>WanSurvey</title>');
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), `console.log(${'"x",'.repeat(2000)}1);`);
    process.env.WEB_DIST = dir;
    resetConfigCache();
    t = await bootstrap();
  });
  afterAll(async () => {
    await t.close();
    delete process.env.WEB_DIST;
    resetConfigCache();
  });

  it('caches hashed assets for a year and compresses them', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/assets/app-abc123.js')
      .set('accept-encoding', 'gzip')
      .expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers client routes with the app shell, always revalidated, with its policy', async () => {
    for (const path of ['/', '/projects/123/cases', '/login']) {
      const res = await request(t.app.getHttpServer()).get(path).expect(200);
      expect(res.text).toContain('<title>WanSurvey</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
    const sw = await request(t.app.getHttpServer()).get('/sw.js').expect(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
  });

  it('gives a missing asset a 404, and leaves the API its own answers and policy', async () => {
    await request(t.app.getHttpServer()).get('/assets/old-999.js').expect(404);
    const api = await request(t.app.getHttpServer()).get('/api/v1/auth/me');
    expect(api.status).toBe(401);
    expect(api.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    await request(t.app.getHttpServer()).get('/api/v1/nothing-here').expect(404);
    await request(t.app.getHttpServer()).get('/health').expect(200);
  });
});
