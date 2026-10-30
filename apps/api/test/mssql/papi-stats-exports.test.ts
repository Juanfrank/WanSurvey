import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CasesStore } from '../../src/cases/cases-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { ExportsStore, EXPORT_STUCK_MS } from '../../src/exports/exports-store.mssql.js';
import { InterviewsStore } from '../../src/interviews/interviews-store.mssql.js';
import { PapiStore, SCAN_MAX_ATTEMPTS } from '../../src/papi/papi-store.mssql.js';
import { QuestionnaireStore } from '../../src/questionnaires/questionnaire-store.mssql.js';
import { StatsStore } from '../../src/stats/stats-store.mssql.js';

/**
 * Paper, statistics and exports on SQL Server (mssql/0008): double-entry differences, scanned
 * batches and their pages, daily figures by the project's local day, export jobs and their pages,
 * summary links, and isolation by organisation. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: paper, statistics and exports', () => {
  let app: MssqlDatabase;
  const papi = new PapiStore();
  const stats = new StatsStore();
  const exportsStore = new ExportsStore();
  const interviews = new InterviewsStore();
  const cases = new CasesStore();
  const questionnaires = new QuestionnaireStore();
  const stamp = Date.now().toString(36);
  const TZ = 'America/Guatemala';
  const a = { id: randomUUID(), slug: `pa-${stamp}`, project: randomUUID() };
  const b = { id: randomUUID(), slug: `pb-${stamp}`, project: randomUUID() };
  const user = randomUUID();
  const ana = randomUUID();
  const luis = randomUUID();
  let q: string;
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
        await sql`INSERT INTO projects (id, tenant_id, name, code, timezone) VALUES (${x.project}, ${x.id}, 'P', ${'P-' + x.slug}, ${TZ})`.execute(
          db,
        );
      }
      for (const [i, id] of [user, ana, luis].entries())
        await sql`INSERT INTO users (id, tenant_id, email, name) VALUES (${id}, ${a.id}, ${`s${i}-${stamp}@example.org`}, ${`S${i}`})`.execute(
          db,
        );
    });
    q = await app.withTenant(a.id, (tx) =>
      questionnaires.create(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Q',
        draft: {},
        userId: user,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      questionnaires.publish(tx, {
        tenantId: a.id,
        questionnaireId: q,
        definition: {},
        compiled: { hash: 'p1' },
        mapping: null,
        userId: user,
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

  const project = async (name: string) => {
    const id = randomUUID();
    await owner((db) =>
      sql`INSERT INTO projects (id, tenant_id, name, code, timezone) VALUES (${id}, ${a.id}, ${name}, ${`${name}-${stamp}`}, ${TZ})`.execute(
        db,
      ),
    );
    return id;
  };

  /** An interview in the project, as the owner writes it so its dates and state can be chosen. */
  const iv = async (
    projectId: string,
    over: {
      status?: string;
      mode?: string;
      interviewer?: string | null;
      submittedAt?: string;
      disposition?: string;
      activeMs?: number;
      entryPass?: number;
      answers?: object;
    } = {},
  ) => {
    const id = randomUUID();
    await app.withTenant(a.id, (tx) =>
      interviews.start(tx, {
        id,
        tenantId: a.id,
        projectId,
        caseId: null,
        questionnaireVersionId: versionId,
        mode: over.mode ?? 'CATI',
        interviewerId: over.interviewer === undefined ? ana : over.interviewer,
        language: 'es',
        context: {},
        deviceId: 'd',
        entryPass: over.entryPass,
      }),
    );
    await owner((db) =>
      sql`UPDATE interviews SET status = ${over.status ?? 'submitted'}, disposition = ${over.disposition ?? 'COMPLETE'},
          submitted_at = ${over.submittedAt ?? '2026-11-02T15:00:00Z'}, active_ms = ${over.activeMs ?? 1000},
          answers = ${JSON.stringify(over.answers ?? { P1: 1 })} WHERE id = ${id}`.execute(db),
    );
    return id;
  };

  describe('paper', () => {
    it('records the differences of a double entry once per variable, and resolves each once', async () => {
      const proj = await project('dbl');
      const [caseId] = await app.withTenant(a.id, (tx) =>
        cases.insertCases(tx, {
          tenantId: a.id,
          projectId: proj,
          cases: [{ externalId: 'form-1' }],
        }),
      );
      const first = await iv(proj);
      const second = await iv(proj, { entryPass: 2 });
      const differences = [
        { variable: 'P1', firstValue: 'a', secondValue: 'b' },
        { variable: 'P2', firstValue: { code: 1 }, secondValue: null },
      ];
      const add = (d = differences) =>
        app.withTenant(a.id, (tx) =>
          papi.addMismatches(tx, {
            tenantId: a.id,
            projectId: proj,
            caseId: caseId!,
            firstInterviewId: first,
            secondInterviewId: second,
            differences: d,
          }),
        );
      await add();
      await expect(add()).rejects.toSatisfy(dup);
      await add([]);
      const open = await app.withTenant(a.id, (tx) => papi.mismatches(tx, proj));
      expect(open.map((m) => [m.external_id, m.variable, m.first_value, m.second_value])).toEqual([
        ['form-1', 'P1', 'a', 'b'],
        ['form-1', 'P2', { code: 1 }, null],
      ]);
      expect(await app.withTenant(a.id, (tx) => papi.openMismatches(tx, caseId!))).toBe(2);
      const resolve = (id: string, value: unknown) =>
        app.withTenant(a.id, (tx) =>
          papi.resolveMismatch(tx, { projectId: proj, id, value, userId: user }),
        );
      const results = await Promise.all([resolve(open[0]!.id, 'a'), resolve(open[0]!.id, 'b')]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await resolve(open[0]!.id, 'c')).toBe(false);
      expect(await app.withTenant(a.id, (tx) => papi.openMismatches(tx, caseId!))).toBe(1);
      const all = await app.withTenant(a.id, (tx) => papi.mismatches(tx, proj, 'resolved'));
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ variable: 'P1', status: 'resolved', resolver: 'S0' });
      expect(await app.withTenant(a.id, (tx) => papi.mismatches(tx, proj, 'all'))).toHaveLength(2);
    });

    it('takes a scanned batch once, and again only when its worker was lost, up to the attempts allowed', async () => {
      const proj = await project('scan');
      const pdf = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
      const id = await app.withTenant(a.id, (tx) =>
        papi.addBatch(tx, {
          tenantId: a.id,
          projectId: proj,
          uploadedBy: user,
          fileName: 'lote.pdf',
          pdf,
        }),
      );
      const claims = await Promise.all(
        Array.from({ length: 6 }, () => app.withTenant(a.id, (tx) => papi.claimBatch(tx, id))),
      );
      expect(claims.filter((c) => c !== null)).toHaveLength(1);
      const got = claims.find((c) => c)!;
      expect(got).toMatchObject({ status: 'running', attempts: 1 });
      expect(Buffer.compare(got.pdf!, pdf)).toBe(0);
      // Running now: nobody else takes it, until it has been running for too long.
      expect(await app.withTenant(a.id, (tx) => papi.claimBatch(tx, id))).toBeNull();
      const lost = new Date(Date.now() + 3_600_000);
      const again = await app.withTenant(a.id, (tx) => papi.claimBatch(tx, id, lost));
      expect(again).toMatchObject({ attempts: 2 });
      expect(
        await app.withTenant(a.id, (tx) =>
          papi.claimBatch(tx, id, new Date(lost.getTime() + 3_600_000)),
        ),
      ).toMatchObject({ attempts: 3 });
      expect(SCAN_MAX_ATTEMPTS).toBe(3);
      expect(
        await app.withTenant(a.id, (tx) =>
          papi.claimBatch(tx, id, new Date(lost.getTime() + 7_200_000)),
        ),
      ).toBeNull();
    });

    it('keeps forms and page images, drops the PDF once read, and deletes a batch with all of it', async () => {
      const proj = await project('pages');
      const [caseId] = await app.withTenant(a.id, (tx) =>
        cases.insertCases(tx, { tenantId: a.id, projectId: proj, cases: [{ externalId: 'f1' }] }),
      );
      const batch = await app.withTenant(a.id, (tx) =>
        papi.addBatch(tx, {
          tenantId: a.id,
          projectId: proj,
          uploadedBy: user,
          fileName: 'x.pdf',
          pdf: Buffer.from('%PDF'),
        }),
      );
      await app.withTenant(a.id, (tx) => papi.claimBatch(tx, batch));
      const form = await app.withTenant(a.id, (tx) =>
        papi.addForm(tx, {
          tenantId: a.id,
          projectId: proj,
          batchId: batch,
          caseId: caseId!,
          questionnaireVersionId: versionId,
          lang: 'es',
          status: 'review',
          pagesExpected: 2,
          pagesFound: [1, 2],
          issues: [{ name: 'P3', kind: 'double_mark', detail: 'A y B' }],
        }),
      );
      const image = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256));
      await app.withTenant(a.id, (tx) =>
        papi.addPages(tx, {
          tenantId: a.id,
          batchId: batch,
          pages: [
            {
              pageNo: 1,
              formId: form,
              formPage: 1,
              transform: { a: 1 },
              width: 800,
              height: 1100,
              image,
            },
            { pageNo: 2, formId: form, formPage: 2, width: 800, height: 1100, image },
            { pageNo: 3, problem: 'no_code', width: 800, height: 1100, image: Buffer.from('x') },
          ],
        }),
      );
      await app.withTenant(a.id, (tx) => papi.finishBatch(tx, batch, { pages: 3 }));
      const batches = await app.withTenant(a.id, (tx) => papi.batches(tx, proj));
      expect(batches[0]).toMatchObject({ file_name: 'x.pdf', status: 'done', pages: 3 });
      const claimed = await app.withTenant(a.id, (tx) =>
        tx
          .selectFrom('papi_scan_batches')
          .select('pdf')
          .where('id', '=', batch)
          .executeTakeFirstOrThrow(),
      );
      expect(claimed.pdf).toBeNull();
      const forms = await app.withTenant(a.id, (tx) => papi.forms(tx, batch));
      expect(forms[0]).toMatchObject({
        lang: 'es',
        status: 'review',
        pages_found: [1, 2],
        issues: [{ name: 'P3', kind: 'double_mark', detail: 'A y B' }],
      });
      await app.withTenant(a.id, (tx) =>
        papi.setFormStatus(tx, form, { status: 'done', issues: [] }),
      );
      expect((await app.withTenant(a.id, (tx) => papi.forms(tx, batch)))[0]).toMatchObject({
        status: 'done',
        issues: [],
      });
      const pages = await app.withTenant(a.id, (tx) => papi.pages(tx, batch));
      expect(pages.map((p) => [p.page_no, p.problem, p.transform])).toEqual([
        [1, null, { a: 1 }],
        [2, null, null],
        [3, 'no_code', null],
      ]);
      const img = await app.withTenant(a.id, (tx) => papi.pageImage(tx, pages[0]!.id));
      expect(Buffer.compare(img!, image)).toBe(0);
      await app.withTenant(a.id, (tx) => papi.deleteBatch(tx, batch));
      expect(await app.withTenant(a.id, (tx) => papi.batches(tx, proj))).toEqual([]);
      expect(await app.withTenant(a.id, (tx) => papi.pages(tx, batch))).toEqual([]);
    });

    it('fails a batch with its reason', async () => {
      const proj = await project('fail');
      const batch = await app.withTenant(a.id, (tx) =>
        papi.addBatch(tx, {
          tenantId: a.id,
          projectId: proj,
          uploadedBy: null,
          fileName: 'bad.pdf',
          pdf: Buffer.from('nope'),
        }),
      );
      await app.withTenant(a.id, (tx) => papi.failBatch(tx, batch, 'Not a PDF'));
      expect((await app.withTenant(a.id, (tx) => papi.batches(tx, proj)))[0]).toMatchObject({
        status: 'failed',
        error: 'Not a PDF',
      });
    });
  });

  describe('statistics', () => {
    it('buckets submissions by the project’s local day and counts each kind', async () => {
      const proj = await project('stats');
      // Guatemala is UTC-6: 05:30Z on the 2nd is still the 1st there; 06:00Z starts the 2nd.
      await iv(proj, { submittedAt: '2026-11-02T05:30:00Z', activeMs: 100 });
      await iv(proj, { submittedAt: '2026-11-02T06:00:00Z', activeMs: 2000 });
      await iv(proj, { submittedAt: '2026-11-02T20:00:00Z', activeMs: 3000, status: 'approved' });
      await iv(proj, { submittedAt: '2026-11-02T21:00:00Z', status: 'rejected' });
      await iv(proj, { submittedAt: '2026-11-02T21:30:00Z', status: 'returned' });
      await iv(proj, {
        submittedAt: '2026-11-02T22:00:00Z',
        disposition: 'REFUSAL',
        activeMs: 500,
      });
      await iv(proj, {
        submittedAt: '2026-11-02T22:30:00Z',
        mode: 'CAWI',
        interviewer: null,
        activeMs: 4000,
      });
      await iv(proj, { submittedAt: '2026-11-02T23:00:00Z', entryPass: 2 });
      await iv(proj, { submittedAt: '2026-11-03T05:59:00Z', status: 'in_progress' });
      const refresh = (day: string) =>
        app.withTenant(a.id, (tx) =>
          stats.refreshDay(tx, { tenantId: a.id, projectId: proj, day, timezone: TZ }),
        );
      await refresh('2026-11-01');
      await refresh('2026-11-02');
      await refresh('2026-11-02');
      const rows = await app.withTenant(a.id, (tx) => stats.daily(tx, { projectId: proj }));
      expect(
        rows.map((r) => [
          r.day,
          r.mode,
          r.interviewer_id,
          r.submitted,
          r.completes,
          r.approved,
          r.rejected,
          r.active_ms,
        ]),
      ).toEqual([
        ['2026-11-01', 'CATI', ana, 1, 1, 0, 0, 100],
        ['2026-11-02', 'CATI', ana, 5, 2, 1, 1, 5000],
        ['2026-11-02', 'CAWI', null, 1, 1, 0, 0, 4000],
      ]);
      const total = await app.withTenant(a.id, (tx) => stats.totals(tx, { projectId: proj }));
      expect(total).toEqual({
        submitted: 7,
        completes: 4,
        approved: 1,
        rejected: 1,
        activeMs: 9100,
      });
      expect(
        await app.withTenant(a.id, (tx) =>
          stats.totals(tx, { projectId: proj, from: '2026-11-02', to: '2026-11-02' }),
        ),
      ).toMatchObject({ submitted: 6 });
      expect(
        await app.withTenant(a.id, (tx) => stats.daily(tx, { projectId: proj, mode: 'CAWI' })),
      ).toHaveLength(1);
      expect(await app.withTenant(a.id, (tx) => stats.timezone(tx, proj))).toBe(TZ);
      expect(await app.withTenant(a.id, (tx) => stats.timezone(tx, randomUUID()))).toBeUndefined();
    });

    it('recomputes every day from scratch, and keeps one row for interviews without an interviewer', async () => {
      const proj = await project('all');
      await iv(proj, { submittedAt: '2026-10-30T12:00:00Z', mode: 'CAWI', interviewer: null });
      await iv(proj, { submittedAt: '2026-10-30T13:00:00Z', mode: 'CAWI', interviewer: null });
      await iv(proj, { submittedAt: '2026-11-02T12:00:00Z' });
      const all = () =>
        app.withTenant(a.id, (tx) =>
          stats.refreshAll(tx, { tenantId: a.id, projectId: proj, timezone: TZ }),
        );
      expect(await all()).toBe(4);
      expect(await all()).toBe(4);
      const rows = await app.withTenant(a.id, (tx) => stats.daily(tx, { projectId: proj }));
      expect(rows.map((r) => [r.day, r.mode, r.submitted])).toEqual([
        ['2026-10-30', 'CAWI', 2],
        ['2026-11-02', 'CATI', 1],
      ]);
      const empty = await project('empty');
      expect(
        await app.withTenant(a.id, (tx) =>
          stats.refreshAll(tx, { tenantId: a.id, projectId: empty, timezone: TZ }),
        ),
      ).toBe(0);
    });
  });

  describe('exports', () => {
    const create = (proj: string, options: Record<string, unknown> = { format: 'csv' }) =>
      app.withTenant(a.id, (tx) =>
        exportsStore.create(tx, {
          tenantId: a.id,
          projectId: proj,
          questionnaireId: q,
          requestedBy: user,
          options,
        }),
      );

    it('takes an export once, again when its worker was lost, and requeues a failed attempt', async () => {
      const proj = await project('job');
      const id = await create(proj);
      const claims = await Promise.all(
        Array.from({ length: 5 }, () => app.withTenant(a.id, (tx) => exportsStore.claim(tx, id))),
      );
      expect(claims.filter((c) => c)).toHaveLength(1);
      expect(claims.find((c) => c)).toMatchObject({
        status: 'running',
        attempts: 1,
        options: { format: 'csv' },
      });
      expect(await app.withTenant(a.id, (tx) => exportsStore.claim(tx, id))).toBeNull();
      await app.withTenant(a.id, (tx) => exportsStore.failed(tx, id, 'storage away', false));
      expect(await app.withTenant(a.id, (tx) => exportsStore.get(tx, id))).toMatchObject({
        status: 'queued',
        error: 'storage away',
      });
      const second = await app.withTenant(a.id, (tx) => exportsStore.claim(tx, id));
      expect(second).toMatchObject({ attempts: 2 });
      const lost = new Date(Date.now() + EXPORT_STUCK_MS + 60_000);
      expect(await app.withTenant(a.id, (tx) => exportsStore.claim(tx, id, lost))).toMatchObject({
        attempts: 3,
      });
      expect(
        await app.withTenant(a.id, (tx) =>
          exportsStore.claim(tx, id, new Date(lost.getTime() + 3_600_000)),
        ),
      ).toBeNull();
      await app.withTenant(a.id, (tx) =>
        exportsStore.done(tx, id, {
          fileName: 'datos.zip',
          contentType: 'application/zip',
          storageKey: `exports/${id}.zip`,
          size: 1234,
          rows: 99,
        }),
      );
      expect(await app.withTenant(a.id, (tx) => exportsStore.get(tx, id))).toMatchObject({
        status: 'done',
        file_name: 'datos.zip',
        rows: 99,
        error: null,
      });
      const list = await app.withTenant(a.id, (tx) => exportsStore.list(tx, proj));
      expect(list.map((e) => e.status)).toEqual(['done']);
    });

    it('purges old exports and returns the files to delete', async () => {
      const proj = await project('purge');
      const old = await create(proj);
      const fresh = await create(proj);
      for (const [id, days] of [
        [old, 40],
        [fresh, 1],
      ] as const) {
        await app.withTenant(a.id, (tx) =>
          exportsStore.done(tx, id, {
            fileName: 'f',
            contentType: 'x',
            storageKey: `k/${id}`,
            size: 1,
            rows: 1,
          }),
        );
        await owner((db) =>
          sql`UPDATE exports SET finished_at = DATEADD(day, ${-days}, SYSDATETIMEOFFSET()) WHERE id = ${id}`.execute(
            db,
          ),
        );
      }
      const keys = await app.withTenant(a.id, (tx) =>
        exportsStore.purge(tx, { projectId: proj, before: new Date(Date.now() - 8 * 86_400_000) }),
      );
      expect(keys).toEqual(
        [`k/${old}`.toUpperCase().replace('K/', 'k/')].map((k) =>
          keys.find((x) => x.toLowerCase() === k.toLowerCase())!,
        ),
      );
      expect(
        (await app.withTenant(a.id, (tx) => exportsStore.list(tx, proj))).map((e) =>
          e.id.toLowerCase(),
        ),
      ).toEqual([fresh]);
    });

    describe('pages of interviews', () => {
      const proj = randomUUID();
      const ids: string[] = [];
      const filter = (over: object = {}) => ({
        projectId: proj,
        questionnaireId: q,
        timezone: TZ,
        ...over,
      });
      const readAll = async (f: ReturnType<typeof filter>, size: number) => {
        const seen: string[] = [];
        let after: { at: string; id: string } | null = null;
        for (let guard = 0; guard < 100; guard++) {
          const page: Awaited<ReturnType<ExportsStore['page']>> = await app.withTenant(a.id, (tx) =>
            exportsStore.page(tx, f, after, size),
          );
          seen.push(...page.interviews.map((i) => i.id));
          after = page.after;
          if (!after) break;
        }
        return seen;
      };

      beforeAll(async () => {
        await owner((db) =>
          sql`INSERT INTO projects (id, tenant_id, name, code, timezone) VALUES (${proj}, ${a.id}, 'Pages', ${'PG-' + stamp}, ${TZ})`.execute(
            db,
          ),
        );
        // Eight at the very same instant (the page key must still tell them apart), then 17 more.
        for (let i = 0; i < 8; i++)
          ids.push(await iv(proj, { submittedAt: '2026-11-02T10:00:00Z' }));
        for (let i = 0; i < 17; i++)
          ids.push(
            await iv(proj, {
              submittedAt: `2026-11-02T${String(11 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00Z`,
              mode: i % 2 ? 'CAPI' : 'CATI',
              interviewer: i % 3 === 0 ? luis : ana,
            }),
          );
        // Not data: still in progress, returned, rejected, second keying.
        await iv(proj, { status: 'in_progress' });
        await iv(proj, { status: 'returned' });
        await iv(proj, { status: 'rejected' });
        await iv(proj, { entryPass: 2 });
      });

      it('reads every counted interview exactly once, whatever the page size and ties in time', async () => {
        for (const size of [1, 3, 10, 25, 100]) {
          const seen = await readAll(filter(), size);
          expect(seen).toHaveLength(25);
          expect(new Set(seen).size).toBe(25);
          expect([...seen].sort()).toEqual([...ids].sort());
        }
        const first = await app.withTenant(a.id, (tx) =>
          exportsStore.page(tx, filter(), null, 100),
        );
        const times = first.interviews.map((i) => i.submitted_at.getTime());
        expect(times).toEqual([...times].sort((x, y) => x - y));
        expect(first.after).toBeNull();
        expect(first.interviews[0]).toMatchObject({
          version: 1,
          language: 'es',
          answers: { P1: 1 },
          sampling: { role: null },
          interviewer: 'S1',
        });
      });

      it('filters by mode, interviewer, completes, approval and local days', async () => {
        const n = async (over: object) => (await readAll(filter(over), 50)).length;
        expect(await n({ mode: 'CAPI' })).toBe(8);
        expect(await n({ interviewerId: luis })).toBe(6);
        expect(await n({ completesOnly: true })).toBe(25);
        expect(await n({ approvedOnly: true })).toBe(0);
        // Guatemala: 10:00Z on the 2nd is 04:00 there, still the 2nd; the 1st and 3rd hold nothing.
        expect(await n({ from: '2026-11-02', to: '2026-11-02' })).toBe(25);
        expect(await n({ from: '2026-11-03' })).toBe(0);
        expect(await n({ to: '2026-11-01' })).toBe(0);
      });

      it('counts the paradata of each interview when asked', async () => {
        const target = ids[0]!;
        await app.withTenant(a.id, (tx) =>
          interviews.appendParadata(tx, {
            tenantId: a.id,
            interviewId: target,
            deviceId: 'd',
            ops: [
              { seq: 1, type: 'navigate_back', at: '2026-11-02T10:00:01Z' },
              { seq: 2, type: 'navigate_back', at: '2026-11-02T10:00:02Z' },
              { seq: 3, type: 'pause', at: '2026-11-02T10:00:03Z' },
              { seq: 4, type: 'warning_confirmed', at: '2026-11-02T10:00:04Z' },
            ],
          }),
        );
        const page = await app.withTenant(a.id, (tx) =>
          exportsStore.page(tx, filter({ paradata: true }), null, 100),
        );
        const mine = page.interviews.find((i) => i.id === target)!;
        expect(mine.paradata).toEqual({ backMoves: 2, notes: 0, pauses: 1, warnings: 1 });
        expect(page.interviews.find((i) => i.id !== target)!.paradata).toEqual({
          backMoves: 0,
          notes: 0,
          pauses: 0,
          warnings: 0,
        });
      });
    });

    it('lets a client open a summary link until it is revoked or expires', async () => {
      const proj = await project('share');
      const link = (h: string, expiresAt?: Date) =>
        app.withTenant(a.id, (tx) =>
          exportsStore.createShare(tx, {
            tenantId: a.id,
            projectId: proj,
            tokenHash: h,
            tokenEnc: 'enc',
            createdBy: user,
            expiresAt,
          }),
        );
      const live = randomUUID().replace(/-/g, '');
      const expired = randomUUID().replace(/-/g, '');
      const revoked = randomUUID().replace(/-/g, '');
      const liveId = await link(live);
      await link(expired, new Date(Date.now() - 1000));
      const revokedId = await link(revoked, new Date(Date.now() + 3_600_000));
      await expect(link(live)).rejects.toSatisfy(dup);
      expect(await app.withTenantOf('share_link_by_hash', live, async (_tx, f) => f)).toMatchObject(
        { id: liveId, tenantId: a.id },
      );
      expect(await app.withTenantOf('share_link_by_hash', expired, async (_tx, f) => f)).toBeNull();
      expect(
        await app.withTenantOf('share_link_by_hash', revoked, async (_tx, f) => f),
      ).toMatchObject({ id: revokedId });
      expect(
        await app.withTenant(a.id, (tx) => exportsStore.revokeShare(tx, proj, revokedId)),
      ).toBe(true);
      expect(
        await app.withTenant(a.id, (tx) => exportsStore.revokeShare(tx, proj, revokedId)),
      ).toBe(false);
      expect(await app.withTenantOf('share_link_by_hash', revoked, async (_tx, f) => f)).toBeNull();
      expect(
        (await app.withTenant(a.id, (tx) => exportsStore.shares(tx, proj))).filter(
          (s) => s.revoked_at,
        ).length,
      ).toBe(1);
    });
  });

  it('lists every organisation for the nightly jobs, and shows another one nothing', async () => {
    const res = await sql<{ tenant_id: string }>`EXEC dbo.all_tenant_ids`.execute(app.db);
    const ids = res.rows.map((r) => r.tenant_id.toLowerCase());
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(await app.withTenant(b.id, (tx) => papi.mismatches(tx, a.project, 'all'))).toEqual([]);
    expect(await app.withTenant(b.id, (tx) => stats.daily(tx, { projectId: a.project }))).toEqual(
      [],
    );
    expect(await app.withTenant(b.id, (tx) => exportsStore.list(tx, a.project))).toEqual([]);
    await expect(
      app.withTenant(b.id, (tx) =>
        exportsStore.create(tx, {
          tenantId: a.id,
          projectId: a.project,
          questionnaireId: q,
          requestedBy: user,
          options: {},
        }),
      ),
    ).rejects.toThrow();
  });
});
