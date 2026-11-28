import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { readXlsx } from 'hucre/xlsx';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { createQuestionnaire, get, newCase, post } from './fixtures.js';
import {
  auditActions,
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
  id: 'FORMATS',
  title: es('Formatos'),
  defaultLanguage: 'es',
  languages: ['es'],
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
      ],
    },
  ],
};

interface Payload {
  interview: { id: string; startedAt: string };
  context: { case: Record<string, unknown> };
  compiled: CompiledQuestionnaire;
}

/** The organisation's regional format: kept on the tenant, read by everyone, used in exports. */
describe.skipIf(!configured)('SQL Server: regional format of the organisation', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let owner: Session;
  let admin: Session;
  let pm: Session;
  let iUser: TestUser;
  let interviewer: Session;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    owner = await login(t, await createUser(t.owner, tenant.id, [{ role: 'owner' }]), tenant.slug);
    admin = await login(t, await createUser(t.owner, tenant.id, [{ role: 'admin' }]), tenant.slug);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    interviewer = await login(t, iUser, tenant.slug);
  });
  afterAll(async () => {
    await t?.close();
  });

  const patch = (s: Session, body: unknown) =>
    s.agent
      .patch('/api/v1/tenant')
      .set('x-csrf-token', s.csrf)
      .send(body as object);

  it('starts following the language, and keeps a locale in its canonical spelling', async () => {
    const before = await owner.agent.get('/api/v1/tenant').expect(200);
    expect(before.body.formatLocale).toBeNull();
    expect((await interviewer.agent.get('/api/v1/auth/me').expect(200)).body.formatLocale).toBe(
      null,
    );

    const res = await patch(owner, { formatLocale: 'en-gb' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.formatLocale).toBe('en-GB');
    // The other settings stay as they were.
    expect((await owner.agent.get('/api/v1/tenant').expect(200)).body).toMatchObject({
      formatLocale: 'en-GB',
      name: before.body.name,
    });
    // Everyone of the organisation writes dates that way, with no permission to its settings.
    expect((await interviewer.agent.get('/api/v1/auth/me').expect(200)).body.formatLocale).toBe(
      'en-GB',
    );
    expect(await auditActions(t.owner, tenant.id)).toContain('tenant.updated');
  });

  it('refuses what is not a locale, and people who may not change the organisation', async () => {
    for (const formatLocale of ['english', 'es_PE', 'xx-YY', '', 42, 'es-PE; DROP TABLE x'])
      expect((await patch(owner, { formatLocale })).status, String(formatLocale)).toBe(400);
    expect((await patch(pm, { formatLocale: 'es-PE' })).status).toBe(403);
    expect((await patch(interviewer, { formatLocale: 'es-PE' })).status).toBe(403);
    // Administrators may, as with the organisation's other settings.
    const res = await patch(admin, { formatLocale: 'es-ES' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.formatLocale).toBe('es-ES');
  });

  it('goes back to following the language with null, and a PATCH without it keeps it', async () => {
    await patch(owner, { formatLocale: 'pt-BR' }).expect(200);
    const named = await patch(owner, { name: 'Formatos S.A.' });
    expect(named.status).toBe(200);
    expect(named.body.formatLocale).toBe('pt-BR');
    const cleared = await patch(owner, { formatLocale: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.formatLocale).toBeNull();
  });

  async function submitted(answers: [string, unknown][]) {
    const caseId = await newCase(t.owner, tenant.id, project, { holder: iUser.id });
    const device = 'device-formats';
    const p = (
      await post(interviewer, `/projects/${project}/interviews`, {
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
      at: new Date().toISOString(),
      source: e.source,
      reason: e.reason ?? null,
    }));
    const synced = await post(interviewer, '/interviews/sync', {
      deviceId: device,
      interviews: [{ id: p.interview.id, ops, state: s.state(), activeMs: 60_000 }],
    });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    const sub = await post(interviewer, `/interviews/${p.interview.id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path: s.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  }

  const csvOf = async (options: object) => {
    const created = await post(pm, `/projects/${project}/exports`, { format: 'csv', ...options });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await t.app.get(JobsService).drain();
    const file = await get(pm, `/projects/${project}/exports/${created.body.id}/file`);
    expect(file.status).toBe(200);
    const [head, row] = file.text.slice(1).split('\r\n');
    // Semicolons where the format's decimal mark is a comma.
    const sep = head!.startsWith('interview_id;') ? ';' : ',';
    const names = head!.split(sep);
    // Quoted cells first: a cell holding the separator is quoted.
    const cells = row!
      .match(sep === ';' ? /("([^"]|"")*"|[^;]*)(;|$)/g : /("([^"]|"")*"|[^,]*)(,|$)/g)!
      .map((c) => c.replace(/[;,]$/, ''));
    const cell = (name: string) => cells[names.indexOf(name)]!.replace(/^"|"$/g, '');
    return Object.assign(cell, { sep });
  };

  it('writes readable CSV the organisation’s way, and leaves the data formats alone', async () => {
    await submitted([
      ['AGE', 30],
      ['WORK', 1],
    ]);
    // No format chosen: as before, ISO moments.
    await patch(owner, { formatLocale: null }).expect(200);
    let cell = await csvOf({ labels: 'labels' });
    expect(cell('started_at')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(cell('WORK')).toBe('Sí');

    await patch(owner, { formatLocale: 'en-GB' }).expect(200);
    cell = await csvOf({ labels: 'labels' });
    // Day first, four-digit year, 24 hours (in the project's time zone).
    expect(cell('started_at')).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
    expect(cell('WORK')).toBe('Sí');

    await patch(owner, { formatLocale: 'en-US' }).expect(200);
    cell = await csvOf({ labels: 'labels' });
    expect(cell('started_at')).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2} \d{1,2}:\d{2}:\d{2} [AP]M$/);
    expect(cell.sep).toBe(',');
    // A decimal comma: semicolons between the fields, as spreadsheets set that way expect.
    await patch(owner, { formatLocale: 'es-ES' }).expect(200);
    cell = await csvOf({ labels: 'labels' });
    expect(cell.sep).toBe(';');
    expect(cell('started_at')).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(cell('AGE')).toBe('30');
    // Codes are data: the file with codes keeps ISO moments whatever the format.
    cell = await csvOf({ labels: 'codes' });
    expect(cell('started_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cell('WORK')).toBe('1');

    // Excel with labels: the moment is a date Excel can sort, at the project's wall-clock time.
    const xlsx = await post(pm, `/projects/${project}/exports`, {
      format: 'xlsx',
      labels: 'labels',
    });
    expect(xlsx.status, JSON.stringify(xlsx.body)).toBe(201);
    await t.app.get(JobsService).drain();
    const bytes = await get(pm, `/projects/${project}/exports/${xlsx.body.id}/file`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = await readXlsx(new Uint8Array(bytes.body as Buffer));
    const [head, row] = wb.sheets.find((s) => s.name === 'data')!.rows;
    const started = row![head!.indexOf('started_at')];
    expect(started).toBeInstanceOf(Date);
    const iso = cell('started_at');
    expect(iso).toMatch(/^\d{4}-/);
    const [{ timezone: tz }] = (
      (await sql`SELECT timezone FROM projects WHERE id = ${project}`.execute(t.owner)) as {
        rows: { timezone: string }[];
      }
    ).rows as [{ timezone: string }];
    const wall = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
    expect((started as Date).toISOString().slice(11, 16)).toBe(wall);
    expect(row![head!.indexOf('WORK')]).toBe('Sí');
    // The codebook says in which zone the moments are.
    const vars = wb.sheets.find((s) => s.name === 'variables')!.rows;
    expect(vars.find((r) => r[0] === 'started_at')?.[1]).toBe(`Start (${tz})`);
    await patch(owner, { formatLocale: null }).expect(200);
  });

  it('gives the respondent’s form the organisation’s format', async () => {
    await patch(owner, { formatLocale: 'es-PE' }).expect(200);
    const link = await pm.agent
      .put(`/api/v1/projects/${project}/open-link`)
      .set('x-csrf-token', pm.csrf)
      .send({ active: true, questionnaireId: qid });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const http = request(t.app.getHttpServer());
    const { token } = (await http.post(`/api/v1/public/o/${link.body.link.slug}/start`).expect(200))
      .body as { token: string };
    const s = await http.get(`/api/v1/public/s/${token}?device=anon-format-1`).expect(200);
    expect(s.body.formatLocale).toBe('es-PE');
    await patch(owner, { formatLocale: null }).expect(200);
    const after = await http.get(`/api/v1/public/s/${token}?device=anon-format-1`).expect(200);
    expect(after.body.formatLocale).toBeNull();
  });
});
