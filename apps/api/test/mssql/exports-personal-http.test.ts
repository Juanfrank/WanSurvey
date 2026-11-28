import { createInterview, type CompiledQuestionnaire } from '@wansurvey/logic';
import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import { readXlsx } from 'hucre/xlsx';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { createQuestionnaire, get, newCase, post } from './fixtures.js';
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
  id: 'PERSONAL',
  title: es('Datos personales'),
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: es('S'),
      items: [
        {
          kind: 'question',
          id: 'FULLNAME',
          name: 'FULLNAME',
          type: 'text',
          personal: true,
          text: es('¿Su nombre?'),
        },
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: es('¿Edad?') },
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
 * Exports leave personal answers out unless asked for (`personalData: 'include'`), and asking
 * for them needs `pii.view`: refused with 403 otherwise, for data files and codebooks alike.
 */
describe.skipIf(!configured)('SQL Server: personal data in exports', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let iUser: TestUser;
  let me: Session;
  let pm: Session;
  let jobs: JobsService;

  beforeAll(async () => {
    t = await bootstrap();
    jobs = t.app.get(JobsService);
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t, iUser, tenant.slug);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
    // One submitted interview with a personal answer.
    const caseId = await newCase(t.owner, tenant.id, project, { holder: iUser.id });
    const device = 'device-personal';
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
    for (const [k, v] of [
      ['FULLNAME', 'Rosa Quispe'],
      ['AGE', 41],
    ] as const) {
      s.setAnswer(k, v);
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
      interviews: [{ id: p.interview.id, ops, state: s.state(), activeMs: 60_000 }],
    });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    const sub = await post(me, `/interviews/${p.interview.id}/submit`, {
      deviceId: device,
      seq: ops.length,
      path: s.pathKeys(),
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  });
  afterAll(async () => {
    await t?.close();
  });

  const fileText = async (s: Session, id: string) => {
    await jobs.drain();
    const f = await get(s, `/projects/${project}/exports/${id}/file`);
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    return f.text;
  };
  const xlsx = async (s: Session, id: string) => {
    await jobs.drain();
    const f = await get(s, `/projects/${project}/exports/${id}/file`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(f.status).toBe(200);
    const wb = await readXlsx(new Uint8Array(f.body as Buffer));
    return JSON.stringify(wb.sheets.map((w) => w.rows));
  };

  it('leaves personal answers out when nothing is said', async () => {
    const res = await post(pm, `/projects/${project}/exports`, { format: 'csv' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const text = await fileText(pm, res.body.id);
    expect(text).toContain('AGE');
    expect(text).not.toContain('FULLNAME');
    expect(text).not.toContain('Quispe');
    const row = (await get(pm, `/projects/${project}/exports`)).body.find(
      (e: { id: string }) => e.id === res.body.id,
    );
    expect(row).toMatchObject({ personal: false, options: { personalData: 'exclude' } });
  });

  it('includes them only when asked for, by someone allowed to see them', async () => {
    const res = await post(pm, `/projects/${project}/exports`, {
      format: 'csv',
      personalData: 'include',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const text = await fileText(pm, res.body.id);
    expect(text).toContain('FULLNAME');
    expect(text).toContain('Rosa Quispe');
    const row = (await get(pm, `/projects/${project}/exports`)).body.find(
      (e: { id: string }) => e.id === res.body.id,
    );
    expect(row).toMatchObject({ personal: true });
  });

  it('the codebook follows the same rule', async () => {
    const lean = await post(pm, `/projects/${project}/exports`, { format: 'codebook' });
    expect(lean.status, JSON.stringify(lean.body)).toBe(201);
    const leanBook = await xlsx(pm, lean.body.id);
    expect(leanBook).toContain('AGE');
    expect(leanBook).not.toContain('FULLNAME');
    const full = await post(pm, `/projects/${project}/exports`, {
      format: 'codebook',
      personalData: 'include',
    });
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    expect(await xlsx(pm, full.body.id)).toContain('FULLNAME');
    expect((await get(pm, `/projects/${project}/exports`)).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: full.body.id, personal: true })]),
    );
  });

  it('the API documentation says the default', async () => {
    const doc = await pm.agent.get('/docs/openapi.json');
    expect(doc.status).toBe(200);
    const body = JSON.stringify(doc.body.paths['/api/v1/projects/{projectId}/exports'].post);
    expect(body).toContain('"personalData"');
    expect(body).toMatch(/"default":"exclude"/);
    expect(body).toContain('PERSONAL_DATA_FORBIDDEN');
  });

  it('refuses personal data to whoever may export but not see it (403)', async () => {
    await sql`UPDATE tenants SET role_permissions = ${JSON.stringify({
      project_manager: ROLE_PERMISSIONS.project_manager.filter((p) => p !== 'pii.view'),
    })} WHERE id = ${tenant.id}`.execute(t.owner);
    try {
      const asked = await post(pm, `/projects/${project}/exports`, {
        format: 'csv',
        personalData: 'include',
      });
      expect(asked.status).toBe(403);
      expect(asked.body.code).toBe('PERSONAL_DATA_FORBIDDEN');
      const book = await post(pm, `/projects/${project}/exports`, {
        format: 'codebook',
        personalData: 'include',
      });
      expect(book.status).toBe(403);
      // Without asking, the export is made, without the personal answers.
      const lean = await post(pm, `/projects/${project}/exports`, { format: 'csv' });
      expect(lean.status, JSON.stringify(lean.body)).toBe(201);
      expect(await fileText(pm, lean.body.id)).not.toContain('Quispe');
      // A file holding personal answers made earlier is not downloaded either.
      const earlier = (await get(pm, `/projects/${project}/exports`)).body.find(
        (e: { personal: boolean; status: string }) => e.personal && e.status === 'done',
      );
      expect(
        (await get(pm, `/projects/${project}/exports/${earlier.id as string}/file`)).status,
      ).toBe(403);
    } finally {
      await sql`UPDATE tenants SET role_permissions = '{}' WHERE id = ${tenant.id}`.execute(
        t.owner,
      );
    }
  });
});
