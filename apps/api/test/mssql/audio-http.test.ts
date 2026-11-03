import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AudioService } from '../../src/audio/audio.service.js';
import { LocalStorage } from '../../src/exports/storage.js';
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
import { createQuestionnaire, newCase as mkCase, patch } from './fixtures.js';

const definition = {
  id: 'AUDIO',
  title: { es: 'Audio' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: { es: '¿Edad?' } },
      ],
    },
  ],
};
const TEXT = 'Vamos a grabar esta entrevista para controlar su calidad. ¿Está de acuerdo?';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Interview recordings: drawn, consented, uploaded, listened to and deleted (ADR 0001, 5). */
describe.skipIf(!configured)('SQL Server: interview audio', () => {
  let t: MssqlTestApp;
  let dir: string;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let me: Session;
  let other: Session;
  let reviewer: Session;
  let pm: Session;
  let iUser: TestUser;
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;
  const api = (s: Session) => s.agent;
  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(`/api/v1${path}`).set('x-csrf-token', s.csrf).send(body);
  const put = (s: Session, path: string, buf: Buffer, headers: Record<string, string>) =>
    s.agent.put(`/api/v1${path}`).set('x-csrf-token', s.csrf).set(headers).send(buf);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-audio-'));
    t = await bootstrap({ audioStorage: new LocalStorage(dir) });
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { definition, publish: true });
    iUser = await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]);
    me = await login(t, iUser, tenant.slug);
    other = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]),
      tenant.slug,
    );
    reviewer = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'supervisor', projectId: project }]),
      tenant.slug,
    );
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(device = 'dev-audio-1') {
    const caseId = await mkCase(t.owner, tenant.id, project, { holder: iUser.id });
    const res = await post(me, `/projects/${project}/interviews`, {
      id: randomUUID(),
      caseId,
      questionnaireId: qid,
      mode: 'CAPI',
      deviceId: device,
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return {
      id: res.body.interview.id as string,
      device,
      audio: res.body.settings.audio as {
        record: boolean;
        consentText?: string;
        consentVersion?: number;
      },
    };
  }
  const consent = (id: string, device: string, granted: boolean, seq = 1) =>
    post(me, '/interviews/sync', {
      deviceId: device,
      interviews: [
        {
          id,
          ops: [
            {
              seq,
              kind: 'paradata',
              type: 'audio_consent',
              at: new Date().toISOString(),
              payload: { granted, version: 1 },
            },
          ],
        },
      ],
    });
  const settings = (audio: object) => patch(pm, `/projects/${project}`, { settings: { audio } });
  const headers = (b: Buffer, extra: Record<string, string> = {}) => ({
    'content-type': 'audio/webm;codecs=opus',
    'x-sha256': sha(b),
    'x-duration-ms': '30000',
    ...extra,
  });

  it('records nothing while the project has it off', async () => {
    const iv = await start();
    expect(iv.audio).toEqual({ record: false });
    const b = Buffer.from('segment-0');
    const res = await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_RECORDED');
  });

  it('asks for consent with the project’s wording, and keeps the audio only after a yes', async () => {
    expect(
      (await settings({ enabled: true, samplePercent: 100, consentText: TEXT, consentVersion: 3 }))
        .status,
    ).toBe(200);
    const iv = await start('dev-audio-2');
    expect(iv.audio).toEqual({ record: true, consentText: TEXT, consentVersion: 3 });

    const b0 = Buffer.from('opus-bytes-0');
    // Before any answer to the request: nothing is kept.
    let res = await put(me, `/interviews/${iv.id}/audio/0`, b0, headers(b0));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONSENT_REQUIRED');
    // A refusal is not consent either.
    expect((await consent(iv.id, iv.device, false)).status).toBe(200);
    res = await put(me, `/interviews/${iv.id}/audio/0`, b0, headers(b0));
    expect(res.body.code).toBe('CONSENT_REQUIRED');
    // The latest answer counts.
    expect((await consent(iv.id, iv.device, true, 2)).status).toBe(200);
    res = await put(me, `/interviews/${iv.id}/audio/0`, b0, headers(b0));
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(readdirSync(join(dir, tenant.id, project, iv.id))).toEqual(['0']);
  });

  it('takes a segment once, refuses bad ones, and is the interviewer’s own', async () => {
    const iv = await start('dev-audio-3');
    await consent(iv.id, iv.device, true);
    const b = Buffer.from('opus-bytes-A');
    expect((await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b))).status).toBe(204);
    // Sent again (a retry): harmless, nothing is written twice.
    expect((await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b))).status).toBe(204);
    expect(
      await rows(sql`SELECT 1 AS x FROM interview_audio WHERE interview_id = ${iv.id}`),
    ).toHaveLength(1);
    // Other audio under the same number, a wrong checksum, a wrong type, nothing at all.
    const c = Buffer.from('opus-bytes-B');
    expect((await put(me, `/interviews/${iv.id}/audio/0`, c, headers(c))).body.code).toBe(
      'SEGMENT_EXISTS',
    );
    expect(
      (await put(me, `/interviews/${iv.id}/audio/1`, c, headers(c, { 'x-sha256': sha(b) }))).body
        .code,
    ).toBe('BAD_HASH');
    expect(
      (
        await put(
          me,
          `/interviews/${iv.id}/audio/1`,
          c,
          headers(c, { 'content-type': 'text/html' }),
        )
      ).body.code,
    ).toBe('BAD_TYPE');
    expect(
      (await put(me, `/interviews/${iv.id}/audio/1`, c, { 'content-type': 'audio/webm' })).body
        .code,
    ).toBe('BAD_HEADERS');
    // Someone else's interview does not exist for them.
    expect((await put(other, `/interviews/${iv.id}/audio/1`, c, headers(c))).status).toBe(404);
    // Too large.
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    expect((await put(me, `/interviews/${iv.id}/audio/2`, big, headers(big))).status).toBe(413);
  });

  it('lets reviewers listen, with range requests, and writes each listening to the log', async () => {
    const iv = await start('dev-audio-4');
    await consent(iv.id, iv.device, true);
    const b = Buffer.from('0123456789abcdefghij');
    await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b)).expect(204);
    const url = `/api/v1/projects/${project}/interviews/${iv.id}/audio`;

    // The interviewer cannot listen to recordings; a reviewer can.
    expect((await api(me).get(url)).status).toBe(403);
    const list = await api(reviewer).get(url);
    expect(list.body).toEqual([
      { segment: 0, bytes: b.length, durationMs: 30000, contentType: 'audio/webm' },
    ]);

    const before = (await auditActions(t.owner, tenant.id)).filter(
      (a) => a === 'audio.listened',
    ).length;
    const whole = await api(reviewer)
      .get(`${url}/0`)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(whole.status).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['cache-control']).toContain('no-store');
    expect((whole.body as Buffer).equals(b)).toBe(true);
    const part = await api(reviewer)
      .get(`${url}/0`)
      .set('range', 'bytes=5-9')
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 5-9/${b.length}`);
    expect((part.body as Buffer).toString()).toBe('56789');
    // Only the listening that starts at the beginning is logged, not each range after it.
    const after = (await auditActions(t.owner, tenant.id)).filter(
      (a) => a === 'audio.listened',
    ).length;
    expect(after - before).toBe(1);
    expect((await api(reviewer).get(`${url}/9`)).status).toBe(404);
  });

  it('never reaches another organisation’s recordings', async () => {
    const iv = await start('dev-audio-5');
    await consent(iv.id, iv.device, true);
    const b = Buffer.from('secret-voice');
    await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b)).expect(204);
    const o2 = await createTenant(t.owner);
    const p2 = await createProject(t.owner, o2.id);
    const s2 = await login(t, await createUser(t.owner, o2.id, [{ role: 'owner' }]), o2.slug);
    expect((await api(s2).get(`/api/v1/projects/${p2}/interviews/${iv.id}/audio`)).body).toEqual(
      [],
    );
    expect((await api(s2).get(`/api/v1/projects/${p2}/interviews/${iv.id}/audio/0`)).status).toBe(
      404,
    );
  });

  it('deletes recordings after the retention period of the decided interviews, and logs it', async () => {
    await settings({ enabled: true, samplePercent: 100, consentText: TEXT, retentionDays: 30 });
    const iv = await start('dev-audio-6');
    await consent(iv.id, iv.device, true);
    const b = Buffer.from('to-expire');
    await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b)).expect(204);
    const kept = join(dir, tenant.id, project, iv.id, '0');
    expect(existsSync(kept)).toBe(true);
    const svc = t.app.get(AudioService);

    // An interview still open is never touched, however old.
    await sql`UPDATE interviews SET started_at = DATEADD(day, -400, SYSDATETIMEOFFSET()) WHERE id = ${iv.id}`.execute(
      t.owner,
    );
    await svc.retentionAll();
    expect(existsSync(kept)).toBe(true);
    // Decided long ago: it goes.
    await sql`UPDATE interviews SET status = 'approved', submitted_at = DATEADD(day, -40, SYSDATETIMEOFFSET()), reviewed_at = DATEADD(day, -31, SYSDATETIMEOFFSET()) WHERE id = ${iv.id}`.execute(
      t.owner,
    );
    expect(await svc.retentionAll()).toBeGreaterThanOrEqual(1);
    expect(existsSync(kept)).toBe(false);
    expect(
      await rows(sql`SELECT 1 AS x FROM interview_audio WHERE interview_id = ${iv.id}`),
    ).toHaveLength(0);
    expect(await auditActions(t.owner, tenant.id)).toContain('audio.deleted');
  });

  it('erases the recordings of a person who asks for their data to be erased', async () => {
    await settings({ enabled: true, samplePercent: 100, consentText: TEXT, retentionDays: 90 });
    const iv = await start('dev-audio-7');
    await consent(iv.id, iv.device, true);
    const b = Buffer.from('a-voice');
    await put(me, `/interviews/${iv.id}/audio/0`, b, headers(b)).expect(204);
    const [c] = await rows(sql`SELECT case_id FROM interviews WHERE id = ${iv.id}`);
    const kept = join(dir, tenant.id, project, iv.id, '0');
    expect(existsSync(kept)).toBe(true);
    const erased = await post(
      pm,
      `/projects/${project}/cases/${String(c!.case_id).toLowerCase()}/erase`,
      { note: 'ARCO 2026-1' },
    );
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    expect(existsSync(kept)).toBe(false);
    expect(
      await rows(sql`SELECT 1 AS x FROM interview_audio WHERE interview_id = ${iv.id}`),
    ).toHaveLength(0);
  });
});
