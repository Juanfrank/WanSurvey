import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CasesStore } from '../../src/cases/cases-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { InterviewsStore } from '../../src/interviews/interviews-store.mssql.js';
import { QuestionnaireStore } from '../../src/questionnaires/questionnaire-store.mssql.js';
import { ReviewStore } from '../../src/review/review-store.mssql.js';

/**
 * Review on SQL Server (mssql/0006): the queue and its filters, comments, review status and its
 * effect on the case, corrections numbered under the interview's lock, coding of "other" texts,
 * and isolation by organisation. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: review', () => {
  let app: MssqlDatabase;
  const review = new ReviewStore();
  const interviews = new InterviewsStore();
  const cases = new CasesStore();
  const questionnaires = new QuestionnaireStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `ra-${stamp}`, project: randomUUID() };
  const b = { id: randomUUID(), slug: `rb-${stamp}`, project: randomUUID() };
  const reviewer = randomUUID();
  const ana = randomUUID();
  const luis = randomUUID();
  let versionId: string;

  const owner = async <T>(
    fn: (db: ReturnType<typeof createMssqlDb<Record<string, never>>>) => Promise<T>,
  ) => {
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      return await fn(db);
    } finally {
      await db.destroy();
    }
  };

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 8 });
    await owner(async (db) => {
      for (const x of [a, b]) {
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${x.id}, ${x.slug}, ${x.slug})`.execute(
          db,
        );
        await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${x.project}, ${x.id}, 'P', ${'P-' + x.slug})`.execute(
          db,
        );
      }
      for (const [i, [id, name]] of (
        [
          [reviewer, 'Rita Revisora'],
          [ana, 'Ana'],
          [luis, 'Luis'],
        ] as const
      ).entries()) {
        await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${`r${i}-${stamp}@example.org`}, ${name})`.execute(
          db,
        );
        await sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${randomUUID()}, ${a.id}, ${id}, 'active')`.execute(
          db,
        );
      }
    });
    const q = await app.withTenant(a.id, (tx) =>
      questionnaires.create(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Q',
        draft: { title: 'Q' },
        userId: reviewer,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      questionnaires.publish(tx, {
        tenantId: a.id,
        questionnaireId: q,
        definition: { title: 'Q' },
        compiled: { hash: 'r1' },
        mapping: null,
        userId: reviewer,
      }),
    );
    versionId = await app.withTenant(a.id, async (tx) =>
      (
        await tx
          .selectFrom('questionnaire_versions')
          .select('id')
          .where('questionnaire_id', '=', q)
          .executeTakeFirstOrThrow()
      ).id.toLowerCase(),
    );
  });
  afterAll(async () => {
    await app?.destroy();
  });

  /** An interview with a case, in the given state, written by the owner so dates can be chosen. */
  const make = async (
    name: string,
    over: {
      status?: string;
      interviewer?: string;
      mode?: string;
      flags?: object;
      sampled?: boolean;
      submittedAt?: string;
      answers?: object;
      project?: string;
    } = {},
  ) => {
    const project = over.project ?? a.project;
    const [caseId] = await app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: project,
        cases: [{ externalId: `${name}-${stamp}` }],
      }),
    );
    const id = randomUUID();
    await app.withTenant(a.id, (tx) =>
      interviews.start(tx, {
        id,
        tenantId: a.id,
        projectId: project,
        caseId: caseId!,
        questionnaireVersionId: versionId,
        mode: over.mode ?? 'CATI',
        interviewerId: over.interviewer ?? ana,
        language: 'es',
        context: {},
        deviceId: 'd',
      }),
    );
    await owner((db) =>
      sql`UPDATE interviews SET status = ${over.status ?? 'submitted'}, flags = ${JSON.stringify(over.flags ?? {})},
            sampled = ${over.sampled ? 1 : 0}, submitted_at = ${over.submittedAt ?? '2026-11-02T10:00:00Z'},
            answers = ${JSON.stringify(over.answers ?? {})} WHERE id = ${id}`.execute(db),
    );
    return { id, caseId: caseId! };
  };

  it('lists interviews to review newest first, with their flags and comment counts, and filters them', async () => {
    const project = randomUUID();
    await owner((db) =>
      sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${project}, ${a.id}, 'Queue', ${'QU-' + stamp})`.execute(
        db,
      ),
    );
    const i1 = await make('q1', {
      project,
      submittedAt: '2026-11-01T09:00:00Z',
      flags: { speeding: true },
    });
    const i2 = await make('q2', {
      project,
      submittedAt: '2026-11-03T09:00:00Z',
      interviewer: luis,
      mode: 'CAPI',
      sampled: true,
    });
    const i3 = await make('q3', {
      project,
      submittedAt: '2026-11-02T09:00:00Z',
      status: 'in_review',
      flags: { speeding: true, straightlining: true },
    });
    await make('q4', { project, status: 'in_progress' });
    await app.withTenant(a.id, (tx) =>
      review.addComment(tx, {
        tenantId: a.id,
        interviewId: i3.id,
        body: 'Revisar',
        authorId: reviewer,
      }),
    );
    const q = (over: Partial<Parameters<ReviewStore['queue']>[1]> = {}) =>
      app.withTenant(a.id, (tx) =>
        review.queue(tx, {
          projectId: project,
          status: ['submitted', 'in_review'],
          page: 1,
          limit: 10,
          ...over,
        }),
      );
    const all = await q();
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.id)).toEqual([i2.id, i3.id, i1.id]);
    expect(all.rows[1]).toMatchObject({
      comments: 1,
      interviewer: 'Ana',
      external_id: `q3-${stamp}`,
      status: 'in_review',
    });
    expect(all.rows[1]!.flags).toEqual({ speeding: true, straightlining: true });
    expect((await q({ status: ['submitted'] })).total).toBe(2);
    expect((await q({ interviewerId: luis })).rows.map((r) => r.id)).toEqual([i2.id]);
    expect((await q({ mode: 'CAPI' })).total).toBe(1);
    expect((await q({ flag: 'speeding' })).rows.map((r) => r.id)).toEqual([i3.id, i1.id]);
    expect((await q({ flag: 'nothing' })).total).toBe(0);
    expect((await q({ sampled: true })).rows.map((r) => r.id)).toEqual([i2.id]);
    expect((await q({ from: '2026-11-02', to: '2026-11-02' })).rows.map((r) => r.id)).toEqual([
      i3.id,
    ]);
    const p2 = await q({ page: 2, limit: 2 });
    expect(p2.total).toBe(3);
    expect(p2.rows.map((r) => r.id)).toEqual([i1.id]);
  });

  it('resolves a comment once', async () => {
    const { id } = await make('comment');
    const c = await app.withTenant(a.id, (tx) =>
      review.addComment(tx, {
        tenantId: a.id,
        interviewId: id,
        variable: 'P1',
        body: '¿Seguro?',
        authorId: reviewer,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      review.addComment(tx, {
        tenantId: a.id,
        interviewId: id,
        body: 'En general bien',
        authorId: reviewer,
      }),
    );
    expect(await app.withTenant(a.id, (tx) => review.resolveComment(tx, c))).toBe(true);
    expect(await app.withTenant(a.id, (tx) => review.resolveComment(tx, c))).toBe(false);
    const list = await app.withTenant(a.id, (tx) => review.comments(tx, id));
    expect(Object.fromEntries(list.map((x) => [x.body, x.resolved_at !== null]))).toEqual({
      '¿Seguro?': true,
      'En general bien': false,
    });
  });

  it('moves the interview through review and what it does to the case', async () => {
    const sent = await make('return');
    await app.withTenant(a.id, async (tx) => {
      await review.setReviewStatus(tx, sent.id, 'returned', reviewer);
      await review.caseInProgress(tx, sent.caseId);
      await review.addComment(tx, {
        tenantId: a.id,
        interviewId: sent.id,
        body: 'Falta la edad',
        authorId: reviewer,
      });
    });
    const mine = await app.withTenant(a.id, (tx) => review.returnedTo(tx, a.project, ana));
    const row = mine.find((m) => m.id === sent.id)!;
    expect(row).toMatchObject({
      comment: 'Falta la edad',
      reviewer: 'Rita Revisora',
      mode: 'CATI',
    });
    expect(row.reviewed_at).toBeInstanceOf(Date);
    expect(
      (await app.withTenant(a.id, (tx) => cases.get(tx, a.project, sent.caseId)))!.status,
    ).toBe('in_progress');
    expect(
      (await app.withTenant(a.id, (tx) => review.returnedTo(tx, a.project, luis))).some(
        (m) => m.id === sent.id,
      ),
    ).toBe(false);

    // A rejection reopens the case: fresh when nobody holds it, assigned when someone does.
    const free = await make('reject-free');
    const held = await make('reject-held');
    await owner((db) =>
      sql`UPDATE cases SET status = 'finalised', disposition = 'COMPLETE' WHERE id IN (${free.caseId}, ${held.caseId})`.execute(
        db,
      ),
    );
    await owner((db) =>
      sql`UPDATE cases SET assigned_to = ${ana} WHERE id = ${held.caseId}`.execute(db),
    );
    await app.withTenant(a.id, async (tx) => {
      await review.reopenCase(tx, free.caseId);
      await review.reopenCase(tx, held.caseId);
    });
    expect(await app.withTenant(a.id, (tx) => cases.get(tx, a.project, free.caseId))).toMatchObject(
      { status: 'fresh', disposition: null },
    );
    expect(await app.withTenant(a.id, (tx) => cases.get(tx, a.project, held.caseId))).toMatchObject(
      { status: 'assigned', disposition: null },
    );
    await app.withTenant(a.id, (tx) => review.setCaseDisposition(tx, held.caseId, 'PARTIAL'));
    expect(
      (await app.withTenant(a.id, (tx) => cases.get(tx, a.project, held.caseId)))!.disposition,
    ).toBe('PARTIAL');
  });

  it('numbers a reviewer’s changes one after another, even when reviewers write at once', async () => {
    const { id } = await make('events');
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.withTenant(a.id, (tx) =>
          review.appendReviewEvents(tx, {
            tenantId: a.id,
            interviewId: id,
            userId: reviewer,
            events: [
              { key: `P${i}`, oldValue: 'a', newValue: { code: i }, reason: 'correction' },
              { key: `P${i}_B`, oldValue: null, newValue: i },
            ],
          }),
        ),
      ),
    );
    const history = await app.withTenant(a.id, (tx) => interviews.answerHistory(tx, id));
    const mine = history.filter((h) => h.device_id === 'review');
    expect(mine.map((h) => h.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(mine.every((h) => h.source === 'reviewer')).toBe(true);
    expect(mine.filter((h) => h.reason === 'correction')).toHaveLength(6);
  });

  it('writes a corrected snapshot that devices will take, with the new disposition', async () => {
    const { id } = await make('correct');
    await app.withTenant(a.id, (tx) =>
      review.writeCorrection(tx, id, {
        state: { cursor: 4 },
        answers: { P1: 'b' },
        disposition: 'PARTIAL',
      }),
    );
    expect(await app.withTenant(a.id, (tx) => interviews.get(tx, id))).toMatchObject({
      state_version: 1,
      state_device: 'review',
      disposition: 'PARTIAL',
      state: { cursor: 4 },
      answers: { P1: 'b' },
    });
  });

  describe('coding of "other" texts', () => {
    const project = randomUUID();
    const variable = 'A6_OCC';
    const ids: string[] = [];

    beforeAll(async () => {
      await owner((db) =>
        sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${project}, ${a.id}, 'Coding', ${'CO-' + stamp})`.execute(
          db,
        ),
      );
      const texts = ['Panadero', ' panadero ', 'PANADERO', 'Carpintero', 'Docente', ''];
      for (const [i, t] of texts.entries())
        ids.push(
          (await make(`code${i}`, { project, answers: { [`${variable}_OTHER`]: t, P1: 1 } })).id,
        );
      // Not counted: still in progress; and a number is not a text.
      ids.push(
        (
          await make('code-open', {
            project,
            status: 'in_progress',
            answers: { [`${variable}_OTHER`]: 'Panadero' },
          })
        ).id,
      );
      ids.push((await make('code-num', { project, answers: { [`${variable}_OTHER`]: 5 } })).id);
    });

    const other = () => app.withTenant(a.id, (tx) => review.otherTexts(tx, project, variable));

    it('finds the texts of counted interviews only', async () => {
      const found = await other();
      expect(found.map((f) => f.value.trim().toLowerCase()).sort()).toEqual([
        'carpintero',
        'docente',
        'panadero',
        'panadero',
        'panadero',
      ]);
      expect(found.every((f) => f.key === `${variable}_OTHER`)).toBe(true);
    });

    it('keeps the list of codes, refusing to drop one in use', async () => {
      const save = (codes: { code: number; label: string }[]) =>
        app.withTenant(a.id, (tx) =>
          review.saveCodeList(tx, { tenantId: a.id, projectId: project, variable, codes }),
        );
      expect(
        await save([
          { code: 1, label: 'Panadero' },
          { code: 2, label: 'Carpintero' },
        ]),
      ).toEqual({ inUse: [] });
      expect(await app.withTenant(a.id, (tx) => review.codes(tx, project, variable))).toEqual([
        { code: 1, label: 'Panadero' },
        { code: 2, label: 'Carpintero' },
      ]);
      expect(
        await save([
          { code: 1, label: 'Panadero/a' },
          { code: 2, label: 'Carpintero' },
          { code: 3, label: 'Docente' },
        ]),
      ).toEqual({ inUse: [] });
    });

    it('gives a code to every interview with the same text, however it is written, and records it', async () => {
      const assign = (texts: string[], code: number | null) =>
        app.withTenant(a.id, (tx) =>
          review.assignCode(tx, {
            tenantId: a.id,
            projectId: project,
            variable,
            texts,
            code,
            userId: reviewer,
          }),
        );
      expect(await assign(['Panadero'], 1)).toBe(3);
      const answers = await app.withTenant(a.id, async (tx) =>
        Promise.all(ids.map((id) => interviews.get(tx, id))),
      );
      expect(answers.map((r) => r!.answers[`${variable}_CODE`])).toEqual([
        1,
        1,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(answers[0]!.answers.P1).toBe(1);
      const history = await app.withTenant(a.id, (tx) => interviews.answerHistory(tx, ids[0]!));
      expect(history.filter((h) => h.device_id === 'review')).toEqual([
        expect.objectContaining({
          variable: `${variable}_CODE`,
          old_value: null,
          new_value: 1,
          source: 'reviewer',
          reason: 'coding',
        }),
      ]);
      // Again: nothing changes. Another code: it changes. No code: it goes.
      expect(await assign(['panadero'], 1)).toBe(0);
      expect(await assign(['panadero'], 3)).toBe(3);
      expect(
        (await app.withTenant(a.id, (tx) => interviews.get(tx, ids[0]!)))!.answers[
          `${variable}_CODE`
        ],
      ).toBe(3);
      expect(await assign(['PANADERO'], null)).toBe(3);
      expect(
        (await app.withTenant(a.id, (tx) => interviews.get(tx, ids[0]!)))!.answers[
          `${variable}_CODE`
        ],
      ).toBeUndefined();
      expect(await app.withTenant(a.id, (tx) => review.codedTexts(tx, project, variable))).toEqual(
        [],
      );
      await expect(assign(['Docente'], 99)).rejects.toThrow(/Unknown code/);
    });

    it('keeps one coded text per distinct text when codings arrive together, and the codes in use stay', async () => {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          app.withTenant(a.id, (tx) =>
            review.assignCode(tx, {
              tenantId: a.id,
              projectId: project,
              variable,
              texts: ['Docente', 'Carpintero'],
              code: 3,
              userId: reviewer,
            }),
          ),
        ),
      );
      const coded = await app.withTenant(a.id, (tx) => review.codedTexts(tx, project, variable));
      expect(coded).toHaveLength(2);
      expect(coded.map((c) => c.text).sort()).toEqual(['carpintero', 'docente']);
      const dropped = await app.withTenant(a.id, (tx) =>
        review.saveCodeList(tx, {
          tenantId: a.id,
          projectId: project,
          variable,
          codes: [{ code: 1, label: 'x' }],
        }),
      );
      expect(dropped.inUse).toEqual([3]);
    });
  });

  it('shows another organisation nothing, and refuses its writes', async () => {
    const { id } = await make('iso');
    expect(
      (
        await app.withTenant(b.id, (tx) =>
          review.queue(tx, { projectId: a.project, status: ['submitted'], page: 1, limit: 5 }),
        )
      ).total,
    ).toBe(0);
    expect(await app.withTenant(b.id, (tx) => review.comments(tx, id))).toEqual([]);
    await expect(
      app.withTenant(b.id, (tx) =>
        review.addComment(tx, { tenantId: a.id, interviewId: id, body: 'x', authorId: reviewer }),
      ),
    ).rejects.toThrow();
  });
});
