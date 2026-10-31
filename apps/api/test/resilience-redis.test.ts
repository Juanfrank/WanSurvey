import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { RedisBus } from '../src/jobs/bus.js';
import { JobsService } from '../src/jobs/jobs.service.js';

/** An unreachable Redis never holds a request. */
describe('resilience without Redis', () => {
  it('never waits on an unreachable Redis to queue a job or publish a notice', async () => {
    const config = { REDIS_URL: 'redis://127.0.0.1:1', NODE_ENV: 'test' } as unknown as AppConfig;
    const jobs = new JobsService(config, 'api');
    const bus = new RedisBus('redis://127.0.0.1:1');
    const started = Date.now();
    expect(await jobs.offer('stats.refresh', { projectId: 'x' })).toBe(false);
    await expect(bus.publish('p', { type: 'x' })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(8000);
    await bus.close();
    await jobs.onModuleDestroy();
  }, 20_000);
});
