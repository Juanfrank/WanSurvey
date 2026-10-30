import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config.js';
import { clientAddress } from '../src/common/health-access.js';
import { bootstrap, type TestApp } from './harness.js';

const base = () => ({ ...process.env });

describe('HEALTH_ALLOWED_IPS settings', () => {
  it('takes single IPs and CIDR ranges, and refuses anything else at start', () => {
    expect(loadConfig({ ...base(), HEALTH_ALLOWED_IPS: '' }).HEALTH_ALLOWED_IPS).toEqual([]);
    expect(
      loadConfig({ ...base(), HEALTH_ALLOWED_IPS: ' 10.0.0.0/8, 127.0.0.1 ,::1,fd00::/8' })
        .HEALTH_ALLOWED_IPS,
    ).toEqual(['10.0.0.0/8', '127.0.0.1', '::1', 'fd00::/8']);
    for (const bad of [
      '10.0.0.0/33',
      '300.1.1.1',
      'localhost',
      '10.0.0.0/8/1',
      '::1/129',
      '10.0.0.0/x',
    ])
      expect(() => loadConfig({ ...base(), HEALTH_ALLOWED_IPS: bad })).toThrow(
        /HEALTH_ALLOWED_IPS/,
      );
  });

  it('reads the address as App Service writes it (ip:port, mapped IPv4)', () => {
    expect(clientAddress('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(clientAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(clientAddress('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(clientAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(clientAddress(undefined)).toBe('');
  });
});

describe('/health restricted by address', () => {
  let t: TestApp;
  beforeAll(async () => {
    process.env.HEALTH_ALLOWED_IPS = '203.0.113.0/24,198.51.100.9,2001:db8::/32';
    resetConfigCache();
    t = await bootstrap();
  });
  afterAll(async () => {
    await t.close();
    delete process.env.HEALTH_ALLOWED_IPS;
    resetConfigCache();
  });

  const from = (xff: string) =>
    request(t.app.getHttpServer()).get('/health').set('x-forwarded-for', xff);

  it('answers the listed addresses: a range, a single IP, IPv6, and the ip:port form', async () => {
    for (const ip of ['203.0.113.77', '198.51.100.9', '2001:db8::5', '203.0.113.77:40000'])
      expect((await from(ip)).status, ip).toBe(200);
  });

  it('answers 404, as an unknown route, to everyone else and does not trust a forged hop', async () => {
    for (const ip of ['203.0.114.1', '198.51.100.10', '2001:db9::1']) {
      const res = await from(ip);
      expect(res.status, ip).toBe(404);
      expect(res.body.message).toBe('Cannot GET /health');
    }
    // A client putting an allowed address first: the proxy's own entry (the last) counts.
    expect((await from('203.0.113.1, 192.0.2.50')).status).toBe(404);
    // The rest of the API is untouched.
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });
});
