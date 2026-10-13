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
  // One light job at a time: a light job can only run alongside an export if they use different queues.
  const config = { ...loadConfig(), REDIS_URL: url!, JOB_CONCURRENCY: 1 };
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

  it('runs exports on their own queue, so other jobs do not wait behind them', async () => {
    const order: string[] = [];
    let releaseExport!: () => void;
    const exportHeld = new Promise<void>((r) => (releaseExport = r));
    let lightDone!: () => void;
    const light = new Promise<void>((r) => (lightDone = r));
    const name = `light.${Date.now()}`;
    worker.register('exports.build', async () => {
      order.push('export started');
      await exportHeld;
      order.push('export done');
    });
    worker.register(name, async () => {
      order.push('light');
      lightDone();
    });
    await api.enqueue('exports.build', { id: 'x' });
    await new Promise((r) => setTimeout(r, 300));
    await api.enqueue(name, {});
    // The light job runs while the export is still working.
    await light;
    expect(order).toEqual(['export started', 'light']);
    releaseExport();
    await new Promise((r) => setTimeout(r, 300));
    expect(order.at(-1)).toBe('export done');
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
