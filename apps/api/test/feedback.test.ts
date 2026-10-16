import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  createProject,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
} from './harness.js';

describe('quick feedback (faces)', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;
  let interviewer: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    pm = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'project_manager' }]));
    interviewer = await login(
      t.app,
      await createUser(t.admin, tenant.id, [{ role: 'interviewer' }]),
    );
    base = `/api/v1/projects/${project}/feedback`;
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);

  it('records a face from its link, a comment once, and slips keyed in the office', async () => {
    const created = await post(pm, base, {
      name: 'Atención en ventanilla',
      question: { es: '¿Cómo lo atendimos hoy?' },
      faces: 3,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, slug, url } = created.body as { id: string; slug: string; url: string };
    expect(url).toMatch(new RegExp(`/f/${slug}$`));
    expect((await post(interviewer, base, { name: 'x', question: { es: 'x' } })).status).toBe(403);

    // Anyone with the link answers, without signing in.
    const pub = request(t.app.getHttpServer());
    const info = await pub.get(`/api/v1/public/f/${slug}`).expect(200);
    expect(info.body).toMatchObject({ faces: 3, askComment: true });
    expect((await pub.post(`/api/v1/public/f/${slug}`).send({ score: 4 })).status).toBe(404);
    const answered = await pub
      .post(`/api/v1/public/f/${slug}`)
      .send({ score: 3, ref: 'ticket-9' })
      .expect(200);
    const { id: rid, key } = answered.body as { id: string; key: string };
    await pub
      .post(`/api/v1/public/f/${slug}/comment`)
      .send({ id: rid, key, comment: 'Rápido' })
      .expect(200);
    // The key is spent: no second comment, and a wrong key does nothing.
    expect(
      (await pub.post(`/api/v1/public/f/${slug}/comment`).send({ id: rid, key, comment: 'Otra' }))
        .status,
    ).toBe(404);
    await pub.post(`/api/v1/public/f/${slug}`).send({ score: 1, channel: 'widget' }).expect(200);
    await post(pm, `${base}/${id}/paper`, { score: 2 }).expect(200);

    const results = await pm.agent.get(`${base}/${id}/results`).expect(200);
    expect(results.body.counts).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(results.body.channels).toEqual({ link: 1, widget: 1, paper: 1 });
    expect(results.body.comments).toMatchObject([{ score: 3, comment: 'Rápido', ref: 'ticket-9' }]);

    // Switched off: the link stops answering.
    await pm.agent
      .patch(`${base}/${id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ active: false })
      .expect(200);
    expect((await pub.get(`/api/v1/public/f/${slug}`)).status).toBe(404);
    const list = await pm.agent.get(base).expect(200);
    expect(list.body[0]).toMatchObject({ id, active: false, counts: { 1: 1, 2: 1, 3: 1 } });

    // Renamed; an answered point cannot be deleted, an unanswered one can.
    await pm.agent
      .patch(`${base}/${id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ name: 'Mostrador central' })
      .expect(200);
    const kept = await pm.agent.delete(`${base}/${id}`).set('x-csrf-token', pm.csrf);
    expect(kept.status).toBe(409);
    expect(kept.body.code).toBe('IN_USE');
    const spare = await post(pm, base, { name: 'Sin uso', question: { es: '¿Qué tal?' } });
    await pm.agent.delete(`${base}/${spare.body.id}`).set('x-csrf-token', pm.csrf).expect(204);
    expect((await pm.agent.get(base).expect(200)).body).toHaveLength(1);
  });

  it('a Likert with follow-up questions: link parameters answer some beforehand, the rest once', async () => {
    const created = await post(pm, base, {
      name: 'Sedes',
      question: { es: '¿Cómo lo atendimos?' },
      faces: 5,
      items: [
        {
          id: 'SEDE',
          type: 'single',
          text: { es: '¿A cuál sede acudió?' },
          options: [
            { code: 1, label: { es: 'Centro' } },
            { code: 2, label: { es: 'Norte' } },
          ],
          param: 'sede',
          required: true,
        },
        {
          id: 'MOTIVO',
          type: 'text',
          long: true,
          text: { es: '¿Qué salió mal?' },
          required: true,
          showIf: { min: 1, max: 2 },
        },
        { id: 'VOLVERIA', type: 'yesno', text: { es: '¿Volvería?' } },
      ],
    }).expect(201);
    const { id, slug } = created.body as { id: string; slug: string };
    expect(created.body.version).toBe(1);
    // Too many questions, or a repeated parameter, are refused.
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `Q${i}`,
      type: 'text',
      text: { es: 'x' },
    }));
    expect((await post(pm, base, { name: 'x', question: { es: 'x' }, items: six })).status).toBe(
      400,
    );

    const pub = request(t.app.getHttpServer());
    const info = await pub.get(`/api/v1/public/f/${slug}`).expect(200);
    expect(info.body.items).toHaveLength(3);
    // The link says the branch: it is recorded and not asked; an unhappy face asks why.
    const a = await pub
      .post(`/api/v1/public/f/${slug}`)
      .send({ score: 1, params: { sede: '2', otro: 'x' } })
      .expect(200);
    expect(a.body.preset).toEqual(['SEDE']);
    const bad = await pub
      .post(`/api/v1/public/f/${slug}/answers`)
      .send({ id: a.body.id, key: a.body.key, answers: { VOLVERIA: 2 } });
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toEqual({ MOTIVO: 'required' });
    await pub
      .post(`/api/v1/public/f/${slug}/answers`)
      .send({
        id: a.body.id,
        key: a.body.key,
        answers: { MOTIVO: 'Esperé mucho', VOLVERIA: 2, SEDE: 1 },
      })
      .expect(200);
    // A happy face: the reason is not asked, so only the yes/no remains.
    const b = await pub.post(`/api/v1/public/f/${slug}`).send({ score: 5, params: { sede: '1' } });
    await pub
      .post(`/api/v1/public/f/${slug}/answers`)
      .send({ id: b.body.id, key: b.body.key, answers: { VOLVERIA: 1, MOTIVO: 'no' } })
      .expect(200);

    const results = await pm.agent.get(`${base}/${id}/results`).expect(200);
    expect(results.body.itemCounts).toEqual({ SEDE: { 1: 1, 2: 1 }, VOLVERIA: { 1: 1, 2: 1 } });
    expect(results.body.texts).toMatchObject([{ item: 'MOTIVO', score: 1, text: 'Esperé mucho' }]);

    // Changing what is asked is a new version; renaming is not.
    const renamed = await pm.agent
      .patch(`${base}/${id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ name: 'Sedes 2026' })
      .expect(200);
    expect(renamed.body.version).toBe(1);
    const edited = await pm.agent
      .patch(`${base}/${id}`)
      .set('x-csrf-token', pm.csrf)
      .send({ items: [created.body.items[0]] })
      .expect(200);
    expect(edited.body.version).toBe(2);
  });
});
