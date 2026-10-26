import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { JobsService } from '../src/jobs/jobs.service.js';

/**
 * Jobs in one process, without Redis (App Service from a zip): within their kind's
 * concurrency, and tried again on failure, as BullMQ's workers would.
 */
describe('jobs without Redis', () => {
  const make = () => {
    const { REDIS_URL: _redis, ...env } = process.env;
    return new JobsService(loadConfig({ ...env, JOB_CONCURRENCY: '2' }), 'api');
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('runs heavy jobs one at a time and light ones up to JOB_CONCURRENCY', async () => {
    const jobs = make();
    let heavy = 0;
    let light = 0;
    let mostHeavy = 0;
    let mostLight = 0;
    jobs.register('exports.build', async () => {
      mostHeavy = Math.max(mostHeavy, ++heavy);
      await tick();
      heavy--;
    });
    jobs.register('stats.touched', async () => {
      mostLight = Math.max(mostLight, ++light);
      await tick();
      light--;
    });
    for (let k = 0; k < 4; k++) {
      await jobs.enqueue('exports.build', { k });
      await jobs.enqueue('stats.touched', { k });
    }
    await jobs.drain();
    expect(mostHeavy).toBe(1);
    expect(mostLight).toBe(2);
  });

  it('tries a failing job three times, then gives up without stopping the others', async () => {
    const jobs = make();
    let tries = 0;
    let other = 0;
    jobs.register('stats.touched', async () => {
      tries++;
      throw new Error('database away');
    });
    jobs.register('bi.refresh', async () => {
      other++;
    });
    await jobs.enqueue('stats.touched', {});
    await jobs.enqueue('bi.refresh', {});
    await jobs.drain();
    expect(tries).toBe(3);
    expect(other).toBe(1);
  });

  it('succeeds on a later try', async () => {
    const jobs = make();
    let tries = 0;
    jobs.register('stats.touched', async () => {
      if (++tries < 2) throw new Error('once');
    });
    await jobs.enqueue('stats.touched', {});
    await jobs.drain();
    expect(tries).toBe(2);
  });
});
