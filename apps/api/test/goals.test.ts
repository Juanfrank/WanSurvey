import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('interviewer goals per period', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let qid: string;
  let ana: TestUser;
  let anaS: Session;
  let supervisor: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    qid = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    ana = await createUser(t.admin, tenant.id, [{ role: 'interviewer', projectId: project }]);
    anaS = await login(t.app, ana);
    supervisor = await login(t.app, await createUser(t.admin, tenant.id, [{ role: 'supervisor' }]));
    base = `/api/v1/projects/${project}/goals`;
  });
  afterAll(() => t.close());

  const post = (s: Session, path: string, body: object) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);

  async function interview(status: string, disposition = 'COMPLETE', entryPass = 1) {
    const [v] =
      await t.admin`select id from questionnaire_versions where questionnaire_id = ${qid}`;
    await t.admin`insert into interviews (id, tenant_id, project_id, questionnaire_version_id, mode,
        interviewer_id, status, disposition, language, device_id, submitted_at, submissions, ended_at, entry_pass)
      values (${uuidv7()}, ${tenant.id}, ${project}, ${v!.id}, ${entryPass > 1 ? 'PAPI' : 'CAPI'}, ${ana.id},
        ${status}, ${disposition}, 'es', 'dev-goal', now(), 1, now(), ${entryPass})`;
  }

  it('sets a goal for a period and counts the completes against the pace', async () => {
    // Only supervisors set goals, and only for people working in the project.
    expect(
      (
        await post(anaS, base, {
          userId: ana.id,
          startsOn: day(-1),
          endsOn: day(1),
          target: 6,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(supervisor, base, {
          userId: uuidv7(),
          startsOn: day(0),
          endsOn: day(1),
          target: 3,
        })
      ).body.code,
    ).toBe('NOT_ASSIGNEE');
    expect(
      (
        await post(supervisor, base, {
          userId: ana.id,
          startsOn: day(2),
          endsOn: day(1),
          target: 3,
        })
      ).status,
    ).toBe(400);
    const goal = await post(supervisor, base, {
      userId: ana.id,
      questionnaireId: qid,
      startsOn: day(-1),
      endsOn: day(1),
      target: 6,
    });
    expect(goal.status, JSON.stringify(goal.body)).toBe(201);

    await interview('submitted');
    await interview('approved');
    await interview('rejected');
    await interview('submitted', 'REFUSAL');
    // The second keying of a paper form checks the first; it is not another complete.
    await interview('submitted', 'COMPLETE', 2);
    const list = await supervisor.agent.get(base).expect(200);
    expect(list.body).toHaveLength(1);
    // Two completes count; the rejected one, the refusal and the second entry do not. 4 were due by today (2/3).
    expect(list.body[0]).toMatchObject({
      name: expect.any(String),
      target: 6,
      completes: 2,
      expectedByToday: 4,
      state: 'behind',
    });

    // The interviewer sees their own goals; edits change the target.
    const mine = await anaS.agent.get(base).expect(200);
    expect(mine.body).toHaveLength(1);
    await supervisor.agent
      .patch(`${base}/${goal.body.id}`)
      .set('x-csrf-token', supervisor.csrf)
      .send({ target: 2 })
      .expect(200);
    expect((await supervisor.agent.get(base)).body[0]).toMatchObject({
      state: 'met',
      percent: 100,
    });
    await supervisor.agent
      .delete(`${base}/${goal.body.id}`)
      .set('x-csrf-token', supervisor.csrf)
      .expect(200);
    expect((await supervisor.agent.get(base)).body).toHaveLength(0);
  });

  it('sets goals per day, business day, week or month, for a person or the whole team', async () => {
    // Today's completes so far (from the test above): two.
    const team = await post(supervisor, base, {
      userId: null,
      frequency: 'daily',
      startsOn: day(-2),
      endsOn: day(2),
      target: 1,
    });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    await post(supervisor, base, {
      userId: ana.id,
      frequency: 'monthly',
      startsOn: day(0),
      endsOn: day(0),
      target: 5,
    }).expect(201);
    const list = (await supervisor.agent.get(base).expect(200)).body as {
      name: string | null;
      frequency: string;
    }[];
    const daily = list.find((g) => g.frequency === 'daily')!;
    expect(daily).toMatchObject({
      name: null,
      windowFrom: day(0),
      windowTo: day(0),
      completes: 2,
      state: 'met',
      periodTarget: 5,
      periodCompletes: 2,
    });
    expect(list.find((g) => g.frequency === 'monthly')).toMatchObject({
      completes: 2,
      target: 5,
      state: 'behind',
    });
    // The interviewer sees their goals and the team's.
    expect((await anaS.agent.get(base)).body).toHaveLength(2);
    expect(
      (
        await post(supervisor, base, {
          userId: null,
          frequency: 'hourly',
          startsOn: day(0),
          endsOn: day(0),
          target: 1,
        })
      ).status,
    ).toBe(400);
  });
});
