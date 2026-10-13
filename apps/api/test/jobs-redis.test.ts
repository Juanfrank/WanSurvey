import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RedisBus } from '../src/jobs/bus.js';
import { JobsService } from '../src/jobs/jobs.service.js';

/**
 * The BullMQ path (M1) against a real Redis: CI sets TEST_REDIS_URL (and REQUIRE_REDIS=1 so
 * the test cannot be skipped there); locally it runs when Redis is available.
 */
const url = process.env.TEST_REDIS_URL;
if (process.env.REQUIRE_REDIS === '1' && !url) throw new Error('TEST_REDIS_URL is required');

describe.skipIf(!url)('jobs on Redis', () => {
  const config = { ...loadConfig(), REDIS_URL: url! };
  const api = new JobsService(config, 'api');
  const worker = new JobsService(config, 'worker');
  const bus = new RedisBus(url!);
  afterAll(async () => {
    await api.onModuleDestroy();
    await worker.onModuleDestroy();
    await bus.close();
  });

  it('runs a job enqueued by the API in the worker, once per job id', async () => {
    const seen: unknown[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const name = `test.${Date.now()}`;
    worker.register(name, async (d) => {
      seen.push(d.n);
      done();
    });
    await worker.onApplicationBootstrap();
    expect(api.inline).toBe(false);
    await api.enqueue(name, { n: 1 }, { jobId: 'same', delayMs: 300 });
    await api.enqueue(name, { n: 2 }, { jobId: 'same', delayMs: 300 });
    await finished;
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toEqual([1]);
  });

  it('carries bus messages between connections', async () => {
    const got = new Promise<Record<string, unknown>>((resolve) => {
      const off = bus.subscribe('project:test', (m) => {
        off();
        resolve(m);
      });
    });
    const other = new RedisBus(url!);
    await new Promise((r) => setTimeout(r, 200));
    await other.publish('project:test', { type: 'stats' });
    expect(await got).toEqual({ type: 'stats' });
    await other.close();
  });
});
