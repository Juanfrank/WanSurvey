import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, configured, type MssqlTestApp } from './harness.js';

describe.skipIf(!configured)('SQL Server: response headers and rate limits', () => {
  let t: MssqlTestApp;
  beforeAll(async () => {
    t = await bootstrap();
  });
  afterAll(() => t.close());

  it('sends the security headers on API responses', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers).toMatchObject({
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(res.headers['x-powered-by']).toBeUndefined();
    // HSTS is sent in production only (tests run as "test").
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('refuses compressed request bodies before parsing them', async () => {
    const { gzipSync } = await import('node:zlib');
    // One valid gzip frame and trailing bytes: what crashes body-parser before 2.4.0.
    const body = Buffer.concat([gzipSync('{"email":"a@b.c"}'), Buffer.from('trailing')]);
    const res = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .set('content-encoding', 'gzip')
      .send(body);
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_ENCODING');
    // The API is still up.
    expect((await request(t.app.getHttpServer()).get('/health')).status).toBe(200);
  });

  it('lets mail clients load the open pixel from other origins', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/t/o/nothing.gif');
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
  });

  it('limits anonymous starts from open links', async () => {
    const http = request(t.app.getHttpServer());
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++)
      statuses.push((await http.post('/api/v1/public/o/no-such-link/start').send({})).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it('limits respondent link requests', async () => {
    const http = request(t.app.getHttpServer());
    let limited = false;
    for (let i = 0; i < 125 && !limited; i++)
      limited =
        (await http.get('/api/v1/public/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status === 429;
    expect(limited).toBe(true);
  });
});
