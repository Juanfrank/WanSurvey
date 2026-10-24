import { existsSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { ExportsService } from '../src/exports/exports.service.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { StatsService } from '../src/stats/stats.service.js';
import {
  PASSWORD,
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
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

describe('metrics, live dashboard, topline, exports and share links', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;
  let qid: string;
  let iUser: TestUser;
  let supUser: TestUser;
  let me: Session;
  let sup: Session;
  let pm: Session;
  let client: Session;
  let jobs: JobsService;

  beforeAll(async () => {
    t = await bootstrap();
    jobs = t.app.get(JobsService);
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    await t.admin`update projects set settings = ${t.admin.json({ fieldwork: { targetCompletes: 50 } })} where id = ${project}`;
    qid = await createQuestionnaire(t.admin, tenant.id, project, { definition, publish: true });
    iUser = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
    supUser = await createUser(t.admin, tenant.id, [{ role: 'supervisor', projectId: project }]);
    me = await login(t.app, iUser);
    sup = await login(t.app, supUser);
    pm = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
    );
    client = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'client_viewer', projectId: project }]),
    );
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  const get = (s: Session, path: string) => s.agent.get(`/api/v1${path}`);

  async function interview(answers: [string, unknown][]) {
    const caseId = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, external_id, sample, status, assigned_to)
      values (${caseId}, ${tenant.id}, ${project}, ${'A' + caseId.slice(-6)}, ${t.admin.json({})}, 'assigned', ${iUser.id})`;
    const device = 'device-analytics';
    const p = (
      await post(me, `/projects/${project}/interviews`, {
        id: uuidv7(),
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
    await post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id: p.interview.id, ops, state: s.state(), activeMs: 600_000 }],
    }).expect(200);
    const sub = await post(me, `/interviews/${p.interview.id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path: s.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    return p.interview.id;
  }

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
    const rows = () =>
      t.admin`select mode, interviewer_id, submitted, completes, approved, rejected, active_ms::int
              from stats_daily where project_id = ${project}`;
    const before = await rows();
    expect(before).toEqual([
      expect.objectContaining({
        mode: 'CAPI',
        interviewer_id: iUser.id,
        submitted: 3,
        completes: 3,
        active_ms: 1_800_000,
      }),
    ]);
    // A rejection takes it out of the completes.
    await post(sup, `/review/interviews/${third}/transition`, { to: 'rejected' }).expect(200);
    await jobs.drain();
    expect((await rows())[0]).toMatchObject({ completes: 2, rejected: 1 });
    await t.admin`update interviews set status = 'submitted' where id = ${third}`;
    await t.app.get(StatsService).recomputeAll();
    expect((await rows())[0]).toMatchObject({ completes: 3, rejected: 0 });
  });

  it('shows the team its metrics, and interviewers only their own', async () => {
    const team = await get(sup, `/projects/${project}/metrics/interviewers`).expect(200);
    expect(team.body.team).toBe(true);
    const row = team.body.interviewers.find(
      (r: { interviewerId: string }) => r.interviewerId === iUser.id,
    );
    expect(row.values).toMatchObject({ completes: 3, meanMinutes: 10, perHour: 6 });
    expect(row.values.itemNonResponse).toBeCloseTo(1 / 12);
    expect(row.values.syncLatencyS).toBeGreaterThanOrEqual(29);
    const own = await get(me, `/projects/${project}/metrics/interviewers`).expect(200);
    expect(own.body.team).toBe(false);
    expect(own.body.interviewers.map((r: { interviewerId: string }) => r.interviewerId)).toEqual([
      iUser.id,
    ]);
    expect((await get(client, `/projects/${project}/metrics/interviewers`)).status).toBe(403);
  });

  it('tabulates the data: topline, crosstab and filters', async () => {
    const top = await get(client, `/projects/${project}/topline`).expect(200);
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

    const filtered = await get(client, `/projects/${project}/topline?where=ZONE:2`).expect(200);
    expect(filtered.body.n).toBe(1);
    const x = await get(client, `/projects/${project}/crosstab?row=WORK&col=ZONE`).expect(200);
    expect(x.body.counts).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect((await get(client, `/projects/${project}/crosstab?row=AGE&col=ZONE`)).status).toBe(400);
    expect((await get(me, `/projects/${project}/topline`)).status).toBe(403);
  });

  it('streams the live dashboard and updates it within 5 seconds of a submission', async () => {
    const server = t.app.getHttpServer();
    if (!server.listening) await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const auth = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: supUser.email, password: PASSWORD }),
    });
    const cookie = auth.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const abort = new AbortController();
    const res = await fetch(`${base}/projects/${project}/live`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextSnapshot = async () => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.includes('event: snapshot'))
            return JSON.parse(
              block
                .split('\n')
                .find((l) => l.startsWith('data: '))!
                .slice(6),
            );
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    const first = await nextSnapshot();
    expect(first).toMatchObject({ target: 50, completes: 3, byMode: { CAPI: 3 } });
    expect(first.quotas).toEqual([{ id: 'Q_WORK', name: 'Trabajan', max: 10, count: 2 }]);
    expect(first.active.map((a: { userId: string }) => a.userId)).toContain(iUser.id);

    const started = Date.now();
    await interview([
      ['AGE', 41],
      ['WORK', 1],
      ['ZONE', 2],
      ['MEDIA', [2]],
    ]);
    const second = await nextSnapshot();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(second).toMatchObject({ completes: 4 });
    expect(second.quotas[0].count).toBe(3);
    abort.abort();
    expect((await get(me, `/projects/${project}/live/snapshot`)).status).toBe(403);
  });

  it('exports CSV and SPSS through the job, audited, for permitted roles only', async () => {
    expect((await post(sup, `/projects/${project}/exports`, { format: 'csv' })).status).toBe(403);
    const csv = await post(pm, `/projects/${project}/exports`, { format: 'csv' }).expect(201);
    const sav = await post(pm, `/projects/${project}/exports`, {
      format: 'sav',
      paradata: true,
    }).expect(201);
    await jobs.drain();
    const list = await get(pm, `/projects/${project}/exports`).expect(200);
    expect(list.body.map((e: { status: string }) => e.status)).toEqual(['done', 'done']);
    expect(list.body[1]).toMatchObject({ rows: 4 });

    const file = await get(pm, `/projects/${project}/exports/${csv.body.id}/file`).expect(200);
    expect(file.headers['content-disposition']).toMatch(/attachment; filename=".+\.csv"/);
    const text = file.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')[0]).toBe(
      'interview_id,case_id,case_code,mode,status,disposition,interviewer,started_at,submitted_at,active_seconds,version,language,selection_role,stratum,inclusion_prob,base_weight,AGE,WORK,ZONE,MEDIA_1,MEDIA_2',
    );
    const bin = await get(pm, `/projects/${project}/exports/${sav.body.id}/file`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((bin.body as Buffer).subarray(0, 4).toString()).toBe('$FL2');

    const audit = await t.admin`select action from audit_log where tenant_id = ${tenant.id}
      and action in ('data.exported', 'data.downloaded') order by at, id`;
    expect(audit.map((a) => a.action)).toEqual([
      'data.exported',
      'data.exported',
      'data.downloaded',
      'data.downloaded',
    ]);
  });

  it('merges all four modes into one dataset with the same variables and codes', async () => {
    const [v] =
      await t.admin`select v.id from questionnaire_versions v where v.questionnaire_id = ${qid}`;
    for (const mode of ['CATI', 'CAWI', 'PAPI']) {
      const id = uuidv7();
      await t.admin`insert into interviews (id, tenant_id, project_id, questionnaire_version_id, mode,
          interviewer_id, status, disposition, language, answers, device_id, submitted_at, submissions, ended_at)
        values (${id}, ${tenant.id}, ${project}, ${v!.id}, ${mode}, ${mode === 'CAWI' ? null : iUser.id},
          'submitted', 'COMPLETE', 'es', ${t.admin.json({ AGE: 20, WORK: 2, ZONE: 1, MEDIA: [1] })},
          ${'dev-' + mode}, now(), 1, now())`;
    }
    const e = await post(pm, `/projects/${project}/exports`, { format: 'csv', labels: 'labels' });
    await jobs.drain();
    const file = await get(pm, `/projects/${project}/exports/${e.body.id}/file`).expect(200);
    const [header, ...lines] = file.text.slice(1).trim().split('\r\n');
    const cols = header!.split(',');
    const rows = lines.map((l) => l.split(','));
    expect(new Set(rows.map((r) => r[cols.indexOf('mode')]))).toEqual(
      new Set(['CAPI', 'CATI', 'CAWI', 'PAPI']),
    );
    for (const r of rows.filter((r) => r[cols.indexOf('mode')] !== 'CAPI')) {
      expect(r[cols.indexOf('WORK')]).toBe('No');
      expect(r[cols.indexOf('MEDIA_1')]).toBe('Sí');
    }
  });

  it('exports Excel with labels and the variables and values sheets', async () => {
    const e = await post(pm, `/projects/${project}/exports`, { format: 'xlsx', labels: 'labels' });
    await jobs.drain();
    const file = await get(pm, `/projects/${project}/exports/${e.body.id}/file`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['data', 'variables', 'values']);
    const data = wb.getWorksheet('data')!;
    const header = (data.getRow(1).values as unknown[]).slice(1);
    const work = header.indexOf('WORK') + 1;
    const labels = new Set<unknown>();
    data.eachRow((row, n) => {
      if (n > 1) labels.add(row.getCell(work).value);
    });
    expect([...labels].sort()).toEqual(['No', 'Sí']);
    const values = wb.getWorksheet('values')!;
    const rows: unknown[][] = [];
    // A blank cell (the streaming writer leaves empty texts out) reads as ''.
    values.eachRow((row) =>
      rows.push([0, 1, 2, 3].map((k) => (row.values as unknown[])[k + 1] ?? '')),
    );
    expect(rows).toContainEqual(['WORK', 1, 'Sí', '']);
    const vars: unknown[][] = [];
    wb.getWorksheet('variables')!.eachRow((row) => vars.push((row.values as unknown[]).slice(1)));
    expect(vars).toContainEqual(['WORK', '¿Trabaja?', 'numeric', 'nominal']);
  });

  it('shares a read-only summary by link until it is revoked', async () => {
    expect((await post(sup, `/projects/${project}/share-links`, {})).status).toBe(403);
    const link = await post(pm, `/projects/${project}/share-links`, { days: 7 }).expect(201);
    const token = (link.body.url as string).split('/share/')[1]!;
    const anon = request(t.app.getHttpServer());
    const s = await anon.get(`/api/v1/public/share/${token}`).expect(200);
    expect(s.body.kpis).toMatchObject({ completes: 7, byMode: { CAPI: 4, CATI: 1 } });
    expect(s.body.target).toBe(50);
    expect(JSON.stringify(s.body)).not.toContain(iUser.email);
    expect((await anon.get(`/api/v1/public/share/${'x'.repeat(32)}`)).status).toBe(404);
    const listed = await get(pm, `/projects/${project}/share-links`).expect(200);
    expect(listed.body[0].url).toBe(link.body.url);
    await post(pm, `/projects/${project}/share-links/${link.body.id}/revoke`).expect(204);
    expect((await anon.get(`/api/v1/public/share/${token}`)).status).toBe(404);
  });
  it('gives an export with personal answers only to people allowed to see personal data', async () => {
    const personal = await post(pm, `/projects/${project}/exports`, { format: 'csv' }).expect(201);
    // Supervisors run exports here, but may not see personal data.
    await t.admin`update tenants set role_permissions = ${t.admin.json({
      supervisor: [...ROLE_PERMISSIONS.supervisor.filter((p) => p !== 'pii.view'), 'exports.run'],
    })} where id = ${tenant.id}`;
    try {
      const own = await post(sup, `/projects/${project}/exports`, { format: 'csv' }).expect(201);
      await jobs.drain();
      const list = await get(sup, `/projects/${project}/exports`).expect(200);
      const byId = new Map(list.body.map((e: { id: string }) => [e.id, e]));
      expect(byId.get(personal.body.id)).toMatchObject({ status: 'done', personal: true });
      expect(byId.get(own.body.id)).toMatchObject({ status: 'done', personal: false });
      const denied = await get(sup, `/projects/${project}/exports/${personal.body.id}/file`);
      expect(denied.status).toBe(403);
      await get(sup, `/projects/${project}/exports/${own.body.id}/file`).expect(200);
      await get(pm, `/projects/${project}/exports/${personal.body.id}/file`).expect(200);
    } finally {
      await t.admin`update tenants set role_permissions = '{}' where id = ${tenant.id}`;
    }
  });
  it('stops an export past the size limit and keeps nothing of it', async () => {
    const config = t.app.get(CONFIG);
    const before = config.EXPORT_MAX_BYTES;
    config.EXPORT_MAX_BYTES = 100;
    try {
      const e = await post(pm, `/projects/${project}/exports`, { format: 'csv' }).expect(201);
      await jobs.drain();
      const list = await get(pm, `/projects/${project}/exports`).expect(200);
      const row = list.body.find((x: { id: string }) => x.id === e.body.id);
      expect(row).toMatchObject({ status: 'failed', error: expect.stringMatching(/larger than/) });
      const dir = join(process.env.EXPORT_DIR!, tenant.id, e.body.id);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    } finally {
      config.EXPORT_MAX_BYTES = before;
    }
  });

  it('reads the data page by page: the same file with pages of 2 interviews as of 500', async () => {
    const svc = t.app.get(ExportsService);
    const file = async () => {
      const e = await post(pm, `/projects/${project}/exports`, {
        format: 'csv',
        rosters: 'long',
      }).expect(201);
      await jobs.drain();
      const res = await get(pm, `/projects/${project}/exports/${e.body.id}/file`)
        .buffer(true)
        .parse((r, cb) => {
          const parts: Buffer[] = [];
          r.on('data', (c: Buffer) => parts.push(c));
          r.on('end', () => cb(null, Buffer.concat(parts)));
        })
        .expect(200);
      return res.body as Buffer;
    };
    const whole = await file();
    svc.pageSize = 2;
    try {
      const paged = await file();
      expect(paged.equals(whole)).toBe(true);
    } finally {
      svc.pageSize = 500;
    }
  });

  it('still downloads an export stored in the database before files went to storage', async () => {
    const [row] = await t.admin`
      insert into exports (id, tenant_id, project_id, questionnaire_id, requested_by, options, status,
                           file_name, content_type, file, size, finished_at)
      select gen_random_uuid(), tenant_id, project_id, questionnaire_id, requested_by,
             options, 'done', 'old.csv', 'text/csv; charset=utf-8', convert_to('a,b', 'UTF8'), 3, now()
      from exports where project_id = ${project} limit 1
      returning id`;
    const res = await get(pm, `/projects/${project}/exports/${row!.id}/file`).expect(200);
    expect(res.text).toBe('a,b');
  });
});
