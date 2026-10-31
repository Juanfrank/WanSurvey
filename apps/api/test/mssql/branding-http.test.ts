import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../../src/config.js';
import { createQuestionnaire } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(!configured)('SQL Server: project logo and the web survey style', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let pm: Session;
  let interviewer: Session;

  beforeAll(async () => {
    process.env.PUBLIC_SURVEY_URL = 'http://survey.test';
    resetConfigCache();
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    interviewer = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer', projectId: project }]),
      tenant.slug,
    );
  });
  afterAll(async () => {
    delete process.env.PUBLIC_SURVEY_URL;
    resetConfigCache();
    await t?.close();
  });

  const base = () => `/api/v1/projects/${project}`;
  const sendLogo = (s: Session, body: Buffer, name: string) =>
    s.agent.put(`${base()}/logo`).set('x-csrf-token', s.csrf).attach('file', body, name);

  it('keeps one logo per project, checks it is an image, and shows it to people of the project', async () => {
    expect((await sendLogo(interviewer, PNG, 'logo.png')).status).toBe(403);
    const notImage = await sendLogo(pm, Buffer.from('<svg onload="x()"></svg>'), 'logo.png');
    expect(notImage.status).toBe(422);
    expect(notImage.body.code).toBe('NOT_AN_IMAGE');
    const tooBig = await sendLogo(pm, Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), 'big.png');
    expect(tooBig.status).toBe(413);

    const up = await sendLogo(pm, PNG, 'logo.png');
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.logoUpdatedAt).toEqual(expect.any(String));
    const img = await interviewer.agent.get(`${base()}/logo`).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);
    const list = await pm.agent.get('/api/v1/projects').expect(200);
    expect(list.body.find((p: { id: string }) => p.id === project).logoUpdatedAt).toBeTruthy();
  });

  it('gives respondents the style and the logo of the project', async () => {
    await pm.agent
      .patch(base())
      .set('x-csrf-token', pm.csrf)
      .send({
        settings: {
          cawi: {
            theme: {
              primary: '#7a1f5c',
              background: '#fff7ed',
              font: 'serif',
              corners: 'pill',
              logo: 'center',
            },
          },
        },
      })
      .expect(200);
    const bad = await pm.agent
      .patch(base())
      .set('x-csrf-token', pm.csrf)
      .send({ settings: { cawi: { theme: { primary: 'red' } } } });
    expect(bad.status).toBe(400);

    const link = await pm.agent
      .put(`${base()}/open-link`)
      .set('x-csrf-token', pm.csrf)
      .send({ active: true, questionnaireId: qid });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const http = request(t.app.getHttpServer());
    const { token } = (await http.post(`/api/v1/public/o/${link.body.link.slug}/start`).expect(200))
      .body as { token: string };
    const s = await http.get(`/api/v1/public/s/${token}?device=anon-brand-1`).expect(200);
    expect(s.body.branding.theme).toMatchObject({
      primary: '#7a1f5c',
      corners: 'pill',
      logo: 'center',
    });
    expect(s.body.branding.logo).toMatch(new RegExp(`^/api/v1/public/s/${token}/logo\\?v=\\d+$`));
    const img = await http.get(s.body.branding.logo).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    await http.get('/api/v1/public/s/not-a-valid-token-000000/logo').expect(404);

    // Removed, or hidden by the style: no logo for respondents.
    await pm.agent.delete(`${base()}/logo`).set('x-csrf-token', pm.csrf).expect(200);
    const after = await http.get(`/api/v1/public/s/${token}?device=anon-brand-1`).expect(200);
    expect(after.body.branding.logo).toBeNull();
    await http.get(`/api/v1/public/s/${token}/logo`).expect(404);
  });
});
