import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatsService } from '../../src/stats/stats.service.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { createQuestionnaire, get, newCase, post, setSettings } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
  type TestUser,
} from './harness.js';

const es = (text: string) => ({ es: text });
const definition = {
  id: 'ANALYTICS',
  title: es('Analítica'),
  defaultLanguage: 'es',
  languages: ['es'],
  quotas: [{ id: 'Q_WORK', name: 'Trabajan', when: 'WORK == 1', max: 10 }],
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: es('¿Edad?') },
        {
          kind: 'question',
          id: 'WORK',
          name: 'WORK',
          type: 'single',
          text: es('¿Trabaja?'),
          options: [
            { code: 1, label: es('Sí') },
            { code: 2, label: es('No') },
          ],
        },
        {
          kind: 'question',
          id: 'ZONE',
          name: 'ZONE',
          type: 'single',
          text: es('¿Zona?'),
          options: [
            { code: 1, label: es('Urbana') },
            { code: 2, label: es('Rural') },
          ],
        },
        {
          kind: 'question',
          id: 'MEDIA',
          name: 'MEDIA',
          type: 'multi',
          text: es('¿Qué medios usa?'),
          options: [
            { code: 1, label: es('Radio') },
            { code: 2, label: es('TV') },
          ],
        },
      ],
    },
  ],
};

interface Payload {
  interview: { id: string; startedAt: string };
  context: { case: Record<string, unknown> };
  compiled: CompiledQuestionnaire;
}

/**
 * Metrics, the live dashboard, tabulations, exports and share links over HTTP on SQL Server (the
 * stream itself is the same code; the snapshot behind it is read here).
 */
describe.skipIf(!configured)(
  'SQL Server: metrics, dashboard, tabulations, exports, sharing',
  () => {
    let t: MssqlTestApp;
    let tenant: { id: string; slug: string };
    let project: string;
    let qid: string;
    let iUser: TestUser;
    let me: Session;
    let sup: Session;
    let pm: Session;
    let client: Session;
    let jobs: JobsService;

    beforeAll(async () => {
      t = await bootstrap();
      jobs = t.app.get(JobsService);
      tenant = await createTenant(t.owner);
      project = await createProject(t.owner, tenant.id);
      await setSettings(t.owner, project, { fieldwork: { targetCompletes: 50 } });
      qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
      iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
      const supUser = await createUser(t.owner, tenant.id, [
        { role: 'supervisor', projectId: project },
      ]);
      me = await login(t, iUser, tenant.slug);
      sup = await login(t, supUser, tenant.slug);
      pm = await login(
        t,
        await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
        tenant.slug,
      );
      client = await login(
        t,
        await createUser(t.owner, tenant.id, [{ role: 'client_viewer', projectId: project }]),
        tenant.slug,
      );
    });
    afterAll(async () => {
      await t?.close();
    });

    const rows = async (q: ReturnType<typeof sql>) =>
      ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

    async function interview(answers: [string, unknown][]) {
      const caseId = await newCase(t.owner, tenant.id, project, { holder: iUser.id });
      const device = 'device-analytics';
      const p = (
        await post(me, `/projects/${project}/interviews`, {
          id: randomUUID(),
          caseId,
          questionnaireId: qid,
          mode: 'CAPI',
          deviceId: device,
        })
      ).body as Payload;
      const s = createInterview(p.compiled, {
        mode: 'CAPI',
        language: 'es',
        seed: p.interview.id,
        now: () => new Date(p.interview.startedAt),
        context: { case: p.context.case },
      });
      for (const [k, v] of answers) {
        s.setAnswer(k, v as never);
        s.next();
      }
      const ops = s.drainEvents().map((e, i) => ({
        seq: i + 1,
        kind: 'answer' as const,
        variable: e.key,
        oldValue: e.oldValue,
        newValue: e.newValue,
        at: new Date(Date.now() - 30_000).toISOString(),
        source: e.source,
        reason: e.reason ?? null,
      }));
      const synced = await post(me, '/interviews/sync', {
        deviceId: device,
        interviews: [{ id: p.interview.id, ops, state: s.state(), activeMs: 600_000 }],
      });
      expect(synced.status, JSON.stringify(synced.body)).toBe(200);
      const sub = await post(me, `/interviews/${p.interview.id}/submit`, {
        deviceId: device,
        seq: ops.length,
        path: s.pathKeys(),
      });
      expect(sub.status, JSON.stringify(sub.body)).toBe(200);
      return p.interview.id;
    }
    const daily = () =>
      rows(
        sql`SELECT mode, interviewer_id, submitted, completes, approved, rejected, active_ms
          FROM stats_daily WHERE project_id = ${project}`,
      );

    it('keeps daily figures current and the nightly recompute agrees', async () => {
      await interview([
        ['AGE', 30],
        ['WORK', 1],
        ['ZONE', 1],
        ['MEDIA', [1, 2]],
      ]);
      await interview([
        ['AGE', 50],
        ['WORK', 2],
        ['ZONE', 1],
        ['MEDIA', [2]],
      ]);
      const third = await interview([
        ['AGE', { $special: 'DK' }],
        ['WORK', 1],
        ['ZONE', 2],
        ['MEDIA', [1]],
      ]);
      await jobs.drain();
      const before = await daily();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        mode: 'CAPI',
        submitted: 3,
        completes: 3,
      });
      expect(Number(before[0]!.active_ms)).toBe(1_800_000);
      expect((before[0]!.interviewer_id as string).toLowerCase()).toBe(iUser.id);
      // A rejection takes it out of the completes.
      expect(
        (await post(sup, `/review/interviews/${third}/transition`, { to: 'rejected' })).status,
      ).toBe(200);
      await jobs.drain();
      expect((await daily())[0]).toMatchObject({ completes: 2, rejected: 1 });
      await sql`UPDATE interviews SET status = 'submitted' WHERE id = ${third}`.execute(t.owner);
      await t.app.get(StatsService).recomputeAll();
      expect((await daily())[0]).toMatchObject({ completes: 3, rejected: 0 });
    });

    it('shows the team its metrics, and interviewers only their own', async () => {
      const team = await get(sup, `/projects/${project}/metrics/interviewers`);
      expect(team.status, JSON.stringify(team.body)).toBe(200);
      expect(team.body.team).toBe(true);
      const row = team.body.interviewers.find(
        (r: { interviewerId: string }) => r.interviewerId === iUser.id,
      );
      expect(row.values).toMatchObject({ completes: 3, meanMinutes: 10, perHour: 6 });
      expect(row.values.itemNonResponse).toBeCloseTo(1 / 12);
      expect(row.values.syncLatencyS).toBeGreaterThanOrEqual(29);
      const own = await get(me, `/projects/${project}/metrics/interviewers`);
      expect(own.status).toBe(200);
      expect(own.body.team).toBe(false);
      expect(own.body.interviewers.map((r: { interviewerId: string }) => r.interviewerId)).toEqual([
        iUser.id,
      ]);
      expect((await get(client, `/projects/${project}/metrics/interviewers`)).status).toBe(403);
    });

    it('tabulates the data: topline, crosstab and filters', async () => {
      const top = await get(client, `/projects/${project}/topline`);
      expect(top.status, JSON.stringify(top.body)).toBe(200);
      expect(top.body.n).toBe(3);
      const work = top.body.items.find((i: { name: string }) => i.name === 'WORK');
      expect(work.rows.map((r: { label: string; count: number }) => [r.label, r.count])).toEqual([
        ['Sí', 2],
        ['No', 1],
      ]);
      const age = top.body.items.find((i: { name: string }) => i.name === 'AGE');
      expect(age).toMatchObject({ kind: 'numeric', n: 2, mean: 40 });
      const media = top.body.items.find((i: { name: string }) => i.name === 'MEDIA');
      expect(media.rows.map((r: { count: number }) => r.count)).toEqual([2, 2]);

      const filtered = await get(client, `/projects/${project}/topline?where=ZONE:2`);
      expect(filtered.body.n).toBe(1);
      const x = await get(client, `/projects/${project}/crosstab?row=WORK&col=ZONE`);
      expect(x.status, JSON.stringify(x.body)).toBe(200);
      expect(x.body.counts).toEqual([
        [1, 1],
        [1, 0],
      ]);
      expect((await get(client, `/projects/${project}/crosstab?row=AGE&col=ZONE`)).status).toBe(
        400,
      );
      expect((await get(me, `/projects/${project}/topline`)).status).toBe(403);
    });

    it('reads the live dashboard: figures, modes, quota cells and who is working', async () => {
      const snap = await get(sup, `/projects/${project}/live/snapshot`);
      expect(snap.status, JSON.stringify(snap.body)).toBe(200);
      expect(snap.body).toMatchObject({ target: 50, completes: 3, byMode: { CAPI: 3 } });
      expect(snap.body.quotas).toEqual([{ id: 'Q_WORK', name: 'Trabajan', max: 10, count: 2 }]);
      expect(snap.body.active.map((a: { userId: string }) => a.userId)).toContain(iUser.id);
      expect((await get(me, `/projects/${project}/live/snapshot`)).status).toBe(403);
    });

    it('exports CSV and SPSS through the job, audited, for permitted roles only', async () => {
      expect((await post(sup, `/projects/${project}/exports`, { format: 'csv' })).status).toBe(403);
      const csv = await post(pm, `/projects/${project}/exports`, { format: 'csv' });
      expect(csv.status, JSON.stringify(csv.body)).toBe(201);
      const sav = await post(pm, `/projects/${project}/exports`, { format: 'sav', paradata: true });
      expect(sav.status, JSON.stringify(sav.body)).toBe(201);
      await jobs.drain();
      const list = await get(pm, `/projects/${project}/exports`);
      expect(list.status).toBe(200);
      expect(list.body.map((e: { status: string }) => e.status)).toEqual(['done', 'done']);
      expect(list.body[1]).toMatchObject({ rows: 3 });

      const file = await get(pm, `/projects/${project}/exports/${csv.body.id}/file`);
      expect(file.status, JSON.stringify(file.body)).toBe(200);
      expect(file.headers['content-disposition']).toMatch(/attachment; filename=".+\.csv"/);
      const text = file.text;
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text.slice(1).split('\r\n')[0]).toContain(
        'interview_id,case_id,case_code,mode,status',
      );
      expect(text).toContain(',AGE,WORK,ZONE,MEDIA_1,MEDIA_2');
      const bin = await get(pm, `/projects/${project}/exports/${sav.body.id}/file`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(bin.status).toBe(200);
      expect((bin.body as Buffer).subarray(0, 4).toString()).toBe('$FL2');

      const audit = await rows(
        sql`SELECT action FROM audit_log WHERE tenant_id = ${tenant.id} AND action LIKE 'data.%'`,
      );
      const actions = audit.map((r) => r.action);
      expect(actions).toContain('data.exported');
      expect(actions).toContain('data.downloaded');
    });

    it('shares a read-only summary by link until it is revoked', async () => {
      expect((await post(sup, `/projects/${project}/share-links`, {})).status).toBe(403);
      const link = await post(pm, `/projects/${project}/share-links`, { days: 7 });
      expect(link.status, JSON.stringify(link.body)).toBe(201);
      const token = (link.body.url as string).split('/share/')[1]!;
      const anon = request(t.app.getHttpServer());
      const s = await anon.get(`/api/v1/public/share/${token}`);
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body.kpis).toMatchObject({ completes: 3, byMode: { CAPI: 3 } });
      expect(s.body.target).toBe(50);
      expect(JSON.stringify(s.body)).not.toContain(iUser.email);
      expect((await anon.get(`/api/v1/public/share/${'x'.repeat(32)}`)).status).toBe(404);
      const listed = await get(pm, `/projects/${project}/share-links`);
      expect(listed.body[0].url).toBe(link.body.url);
      expect(
        (await post(pm, `/projects/${project}/share-links/${link.body.id}/revoke`)).status,
      ).toBe(204);
      expect((await anon.get(`/api/v1/public/share/${token}`)).status).toBe(404);
    });
  },
);
