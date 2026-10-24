/* global process, setInterval, clearInterval, console */
/**
 * Memory of one export, measured: the worker's services (built: `pnpm build`) make an export
 * of a whole project into the configured storage while the process's peak memory is recorded.
 * Used to check streaming exports against a large project (load/results.md).
 *   NODE_OPTIONS=--max-old-space-size=256 EXPORT_STORAGE=blob AZURE_STORAGE_CONNECTION_STRING=… \
 *   DATABASE_URL=… DATABASE_ADMIN_URL=… node scripts/export-memory.mjs <projectId> <format> [wide|long]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import postgres from 'postgres';
import { AppModule } from '../dist/app.module.js';
import { ExportsService } from '../dist/exports/exports.service.js';

const [projectId, format, rosters = 'wide'] = process.argv.slice(2);
const admin = postgres(process.env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
const [p] = await admin`
  select p.tenant_id, q.id as qid,
         (select user_id from tenant_members m where m.tenant_id = p.tenant_id limit 1) as uid
  from projects p join questionnaires q on q.project_id = p.id where p.id = ${projectId} limit 1`;
const options = { format, rosters, labels: 'codes', paradata: false, approvedOnly: false };
const [row] = await admin`
  insert into exports (id, tenant_id, project_id, questionnaire_id, requested_by, options)
  values (gen_random_uuid(), ${p.tenant_id}, ${projectId}, ${p.qid}, ${p.uid},
          ${admin.json({ ...options, questionnaireId: p.qid, personal: true })})
  returning id`;
const app = await NestFactory.createApplicationContext(AppModule.register({ role: 'worker' }), {
  logger: ['error', 'warn'],
});
await app.init();
let peak = 0;
const tick = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
const t0 = Date.now();
await app.get(ExportsService).build(p.tenant_id, row.id);
const ms = Date.now() - t0;
clearInterval(tick);
const [done] =
  await admin`select status, error, size, rows, file_name from exports where id = ${row.id}`;
console.log(
  JSON.stringify({
    format,
    status: done.status,
    error: done.error,
    rows: done.rows,
    sizeMB: Math.round((done.size ?? 0) / 1e5) / 10,
    seconds: Math.round(ms / 100) / 10,
    peakRssMB: Math.round(peak / 1e6),
  }),
);
await app.close();
await admin.end();
process.exit(0);
