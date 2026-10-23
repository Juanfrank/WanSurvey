import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { RedisBus } from '../src/jobs/bus.js';
import { ExportsService } from '../src/exports/exports.service.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { SweeperService } from '../src/jobs/sweeper.service.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  type TestApp,
} from './harness.js';

/** Work survives a lost worker, and an unreachable Redis never holds a request. */
describe('resilience', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let user: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    user = (await createUser(t.admin, tenant.id, [{ role: 'project_manager' }])).id;
  });
  afterAll(() => t.close());

  const exportRow = async (fields: Record<string, unknown>) => {
    const id = uuidv7();
    await t.admin`insert into exports ${t.admin({
      id,
      tenant_id: tenant.id,
      project_id: project,
      questionnaire_id: qid,
      requested_by: user,
      options: t.admin.json({ format: 'csv' }),
      ...fields,
    } as never)}`;
    return id;
  };

  it('retries exports left behind by a lost worker, and gives up after the last try', async () => {
    const hourAgo = new Date(Date.now() - 3600_000);
    const stuck = await exportRow({ status: 'running', started_at: hourAgo, attempts: 1 });
    const spent = await exportRow({ status: 'running', started_at: hourAgo, attempts: 3 });
    const fresh = await exportRow({ status: 'queued' });
    const r = await t.app.get(SweeperService).sweep();
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    await t.app.get(JobsService).drain();
    const rows =
      await t.admin`select id, status, attempts, error from exports where id in (${stuck}, ${spent}, ${fresh})`;
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    // Taken again and built; the one out of tries is failed with the reason.
    expect(by[stuck]).toMatchObject({ status: 'done', attempts: 2 });
    expect(by[spent]).toMatchObject({ status: 'failed', error: 'Stopped after 3 attempts' });
    // Just asked for: left to its own job.
    expect(by[fresh]!.status).toBe('queued');
  }, 60_000);

  it('deletes the files of old exports and keeps the request', async () => {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const stale = await exportRow({ status: 'done', finished_at: old, file: Buffer.from('x') });
    const recent = await exportRow({
      status: 'done',
      finished_at: new Date(),
      file: Buffer.from('y'),
    });
    expect(await t.app.get(ExportsService).expireOld()).toBeGreaterThanOrEqual(1);
    const rows =
      await t.admin`select id, status, file is null as gone from exports where id in (${stale}, ${recent})`;
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(by[stale]).toMatchObject({ status: 'expired', gone: true });
    expect(by[recent]).toMatchObject({ status: 'done', gone: false });
  });

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
