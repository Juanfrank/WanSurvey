import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { Public } from '../src/common/auth-context.js';
import { SESSION_COOKIE } from '../src/common/cookies.js';
import { RedisThrottlerStorage, sessionOrIp } from '../src/common/throttle.js';

const url = process.env.TEST_REDIS_URL;
if (process.env.REQUIRE_REDIS === '1' && !url) throw new Error('TEST_REDIS_URL is required');

class Routes {
  @Public()
  login() {}
  me() {}
}
const ctx = (handler: () => void) =>
  ({ getHandler: () => handler, getClass: () => Routes }) as unknown as ExecutionContext;

describe('who a request counts against', () => {
  it('signed-in routes count per session; public ones per IP, whatever cookie is sent', () => {
    const a = { ip: '203.0.113.7', cookies: { [SESSION_COOKIE]: 'tenant.token-a' } };
    const b = { ip: '203.0.113.7', cookies: { [SESSION_COOKIE]: 'tenant.token-b' } };
    const me = ctx(Routes.prototype.me);
    // Two interviewers behind one office address: two counters.
    expect(sessionOrIp(a, me)).not.toBe(sessionOrIp(b, me));
    expect(sessionOrIp(a, me)).toMatch(/^s:/);
    expect(sessionOrIp(a, me)).not.toContain('token-a');
    // Sign-in: by address, so inventing cookies does not reset the limit.
    const login = ctx(Routes.prototype.login);
    expect(sessionOrIp(a, login)).toBe('203.0.113.7');
    expect(sessionOrIp(b, login)).toBe('203.0.113.7');
    expect(sessionOrIp({ ip: '198.51.100.1' }, me)).toBe('198.51.100.1');
  });
});

describe.skipIf(!url)('rate-limit counters in Redis', () => {
  it('are shared by every instance and block over the limit', async () => {
    const one = new RedisThrottlerStorage(url!);
    const two = new RedisThrottlerStorage(url!);
    const key = `test-${Date.now()}-${Math.random()}`;
    try {
      const a = await one.increment(key, 60_000, 3, 60_000, 'default');
      const b = await two.increment(key, 60_000, 3, 60_000, 'default');
      const c = await one.increment(key, 60_000, 3, 60_000, 'default');
      expect([a.totalHits, b.totalHits, c.totalHits]).toEqual([1, 2, 3]);
      expect(c.isBlocked).toBe(false);
      const d = await two.increment(key, 60_000, 3, 60_000, 'default');
      expect(d).toMatchObject({ totalHits: 4, isBlocked: true });
      expect(d.timeToBlockExpire).toBeGreaterThan(0);
      expect(d.timeToExpire).toBeLessThanOrEqual(60);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('let requests through when Redis cannot answer', async () => {
    const down = new RedisThrottlerStorage('redis://127.0.0.1:1');
    const r = await down.increment('k', 60_000, 1, 60_000, 'default');
    expect(r).toMatchObject({ totalHits: 0, isBlocked: false });
    await down.close();
  });
});
