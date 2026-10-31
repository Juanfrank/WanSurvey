import { household } from '@wansurvey/fixtures';
import { Questionnaire } from '@wansurvey/schema';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** Comments, presence and the question library over HTTP on SQL Server (test/collab.test.ts). */
describe.skipIf(!configured)('SQL Server: comments, presence and the question library', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let pm: Session;
  let client: Session;
  let clerk: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    qid = await createQuestionnaire(t.owner, tenant.id, project);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    client = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'client_viewer' }]),
      tenant.slug,
    );
    clerk = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'interviewer' }]),
      tenant.slug,
    );
    base = `/api/v1/projects/${project}/questionnaires/${qid}`;
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  const send = (
    s: Session,
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) =>
    s.agent[method](path)
      .set('x-csrf-token', s.csrf)
      .send(body ?? {});

  it('threads comments on items: reply, resolve, reopen, delete own', async () => {
    const c = await send(client, 'post', `${base}/comments`, {
      itemId: 'A2',
      body: 'Is age in years?',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const general = await send(pm, 'post', `${base}/comments`, { body: 'Ready for round 2' });
    expect(general.body.itemId).toBeNull();
    // Replies take their thread's item; replying to a reply is refused.
    const r = await send(pm, 'post', `${base}/comments`, {
      parentId: c.body.id,
      body: 'Yes, completed years.',
    });
    expect(r.body).toMatchObject({ itemId: 'A2', parentId: c.body.id });
    const nested = await send(pm, 'post', `${base}/comments`, { parentId: r.body.id, body: 'x' });
    expect(nested.status).toBe(400);
    expect(nested.body.code).toBe('NOT_A_THREAD');
    // The data entry clerk can read questionnaires but not comment.
    expect((await send(clerk, 'post', `${base}/comments`, { body: 'x' })).status).toBe(403);
    expect((await clerk.agent.get(`${base}/comments`)).status).toBe(200);

    const resolved = await send(client, 'post', `${base}/comments/${c.body.id}/resolve`);
    expect(resolved.body.resolvedAt).toBeTruthy();
    const open = await pm.agent.get(`${base}/comments`).query({ status: 'open' });
    expect(open.body.map((x: { id: string }) => x.id)).toEqual([general.body.id]);
    const all = await pm.agent.get(`${base}/comments`);
    expect(all.body).toHaveLength(3);
    expect(all.body.find((x: { id: string }) => x.id === c.body.id)).toMatchObject({
      authorName: expect.any(String),
      resolvedByName: expect.any(String),
      mine: false,
    });
    // A new reply reopens the thread.
    await send(client, 'post', `${base}/comments`, { parentId: c.body.id, body: 'Thanks' });
    const again = await pm.agent.get(`${base}/comments`).query({ status: 'open' });
    expect(again.body.filter((x: { parentId: string | null }) => !x.parentId)).toHaveLength(2);

    // Only the author deletes, and only without replies.
    expect((await send(pm, 'delete', `${base}/comments/${c.body.id}`)).status).toBe(403);
    expect((await send(client, 'delete', `${base}/comments/${c.body.id}`)).body.code).toBe(
      'HAS_REPLIES',
    );
    expect((await send(pm, 'delete', `${base}/comments/${general.body.id}`)).status).toBe(204);
  });

  it('reports who else has the questionnaire open, and the draft head', async () => {
    const mine = await send(pm, 'put', `${base}/presence`, { itemId: 'A1' });
    expect(mine.status).toBe(200);
    expect(mine.body.editors).toEqual([]);
    expect(mine.body.head).toMatchObject({ draftRevision: 1 });
    const theirs = await send(client, 'put', `${base}/presence`, { itemId: 'B1' });
    expect(theirs.body.editors).toEqual([
      expect.objectContaining({ itemId: 'A1', name: expect.any(String) }),
    ]);
    // Stale heartbeats drop out.
    await sql`UPDATE questionnaire_presence SET last_seen = DATEADD(minute, -1, SYSDATETIMEOFFSET()) WHERE questionnaire_id = ${qid} AND item_id = 'A1'`.execute(
      t.owner,
    );
    expect((await client.agent.get(`${base}/presence`)).body.editors).toEqual([]);
    expect((await send(client, 'delete', `${base}/presence`)).status).toBe(204);
    expect((await pm.agent.get(`${base}/presence`)).body.editors).toEqual([]);
  });

  it('keeps items, blocks and rosters in the library with their answer sets', async () => {
    const roster = Questionnaire.parse(household).sections[1]!.items.find((n) => n.id === 'HH');
    const created = await send(pm, 'post', '/api/v1/library', {
      name: 'Household roster',
      description: 'Members with age, sex and work',
      tags: ['demographics'],
      languages: ['en', 'es'],
      content: { node: roster, answerSets: {} },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bad = await send(pm, 'post', '/api/v1/library', {
      name: 'Broken',
      languages: ['en'],
      content: { node: { kind: 'question', id: 'X' } },
    });
    expect(bad.status).toBe(400);
    expect((await send(client, 'post', '/api/v1/library', { name: 'x' })).status).toBe(403);

    const byTag = await client.agent.get('/api/v1/library').query({ tag: 'demographics' });
    expect(byTag.body.map((x: { name: string }) => x.name)).toEqual(['Household roster']);
    expect(byTag.body[0].content.node.id).toBe('HH');
    expect((await client.agent.get('/api/v1/library').query({ q: 'sex' })).body).toHaveLength(1);
    expect((await client.agent.get('/api/v1/library').query({ q: 'nothing' })).body).toHaveLength(
      0,
    );

    const renamed = await send(pm, 'patch', `/api/v1/library/${created.body.id}`, {
      tags: ['demographics', 'core'],
    });
    expect(renamed.body.tags).toEqual(['demographics', 'core']);

    // Other organisations do not see it.
    const other = await createTenant(t.owner);
    const outsider = await login(
      t,
      await createUser(t.owner, other.id, [{ role: 'project_manager' }]),
      other.slug,
    );
    expect((await outsider.agent.get('/api/v1/library')).body).toEqual([]);

    expect((await send(pm, 'delete', `/api/v1/library/${created.body.id}`)).status).toBe(204);
    const audit = await rows(
      sql`SELECT action FROM audit_log WHERE target_id = ${created.body.id} ORDER BY at, id`,
    );
    expect(audit.map((a) => a.action)).toEqual(['library_item.created', 'library_item.deleted']);
  });
});
