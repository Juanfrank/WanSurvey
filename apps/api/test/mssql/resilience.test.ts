import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportsService } from '../../src/exports/exports.service.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { SweeperService } from '../../src/jobs/sweeper.service.js';
import { createQuestionnaire } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  type MssqlTestApp,
} from './harness.js';

/** Work survives a lost worker (test/resilience.test.ts), on SQL Server. */
describe.skipIf(!configured)('SQL Server: resilience', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let user: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    user = (await createUser(t.owner, tenant.id, [{ role: 'project_manager' }])).id;
  });
  afterAll(async () => {
    await t?.close();
  });

  const at = (d: Date) => sql`CAST(${d.toISOString()} AS datetimeoffset(3))`;
  const exportRow = async (f: {
    status: string;
    startedAt?: Date;
    attempts?: number;
    finishedAt?: Date;
    file?: Buffer;
  }) => {
    const id = randomUUID();
    await sql`INSERT INTO exports (id, tenant_id, project_id, questionnaire_id, requested_by, options, status, started_at, attempts, finished_at)
              VALUES (${id}, ${tenant.id}, ${project}, ${qid}, ${user}, ${JSON.stringify({ format: 'csv' })}, ${f.status},
                ${f.startedAt ? at(f.startedAt) : null}, ${f.attempts ?? 0}, ${f.finishedAt ? at(f.finishedAt) : null})`.execute(
      t.owner,
    );
    if (f.file) await sql`UPDATE exports SET file = ${f.file} WHERE id = ${id}`.execute(t.owner);
    return id;
  };
  const rowsOf = async (ids: string[]): Promise<Record<string, unknown>[]> =>
    (
      (await sql<
        Record<string, unknown>
      >`SELECT id, status, attempts, error, CASE WHEN file IS NULL THEN 1 ELSE 0 END AS gone FROM exports WHERE id IN (${sql.join(ids)})`.execute(
        t.owner,
      )) as { rows: Record<string, unknown>[] }
    ).rows.map((r) => ({ ...r, id: String(r.id).toLowerCase() }));

  it('retries exports left behind by a lost worker, and gives up after the last try', async () => {
    const hourAgo = new Date(Date.now() - 3600_000);
    const stuck = await exportRow({ status: 'running', startedAt: hourAgo, attempts: 1 });
    const spent = await exportRow({ status: 'running', startedAt: hourAgo, attempts: 3 });
    const fresh = await exportRow({ status: 'queued' });
    const r = await t.app.get(SweeperService).sweep();
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    await t.app.get(JobsService).drain();
    const by = Object.fromEntries((await rowsOf([stuck, spent, fresh])).map((x) => [x.id, x]));
    // Taken again and built; the one out of tries is failed with the reason.
    expect(by[stuck]).toMatchObject({ status: 'done' });
    expect(Number(by[stuck]!.attempts)).toBe(2);
    expect(by[spent]).toMatchObject({ status: 'failed', error: 'Stopped after 3 attempts' });
    // Just asked for: left to its own job.
    expect(by[fresh]!.status).toBe('queued');
  }, 60_000);

  it('deletes the files of old exports and keeps the request', async () => {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const stale = await exportRow({ status: 'done', finishedAt: old, file: Buffer.from('x') });
    const recent = await exportRow({
      status: 'done',
      finishedAt: new Date(),
      file: Buffer.from('y'),
    });
    expect(await t.app.get(ExportsService).expireOld()).toBeGreaterThanOrEqual(1);
    const by = Object.fromEntries((await rowsOf([stale, recent])).map((x) => [x.id, x]));
    expect(by[stale]).toMatchObject({ status: 'expired' });
    expect(Number(by[stale]!.gone)).toBe(1);
    expect(by[recent]).toMatchObject({ status: 'done' });
    expect(Number(by[recent]!.gone)).toBe(0);
  });
});
