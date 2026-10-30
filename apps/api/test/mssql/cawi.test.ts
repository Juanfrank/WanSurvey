import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CasesStore } from '../../src/cases/cases-store.mssql.js';
import { CawiStore } from '../../src/cawi/cawi-store.mssql.js';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { QuestionnaireStore } from '../../src/questionnaires/questionnaire-store.mssql.js';

/**
 * Web surveys, e-mail and quick feedback on SQL Server (mssql/0007): waves and invitations, the
 * dispatcher's leases, reminders, tracking, bounces and suppressions, open links and feedback, the
 * public lookups that find the organisation from a token or a slug, and isolation by organisation.
 * Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;
const dup = (e: unknown) => [2601, 2627].includes((e as { number?: number }).number ?? 0);

describe.skipIf(!ADMIN || !APP)('SQL Server: web surveys, e-mail and feedback', () => {
  let app: MssqlDatabase;
  const cawi = new CawiStore();
  const cases = new CasesStore();
  const questionnaires = new QuestionnaireStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `wa-${stamp}`, project: randomUUID() };
  const b = { id: randomUUID(), slug: `wb-${stamp}`, project: randomUUID() };
  const user = randomUUID();
  let q: string;

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
    });
    q = await app.withTenant(a.id, (tx) =>
      questionnaires.create(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Q',
        draft: { title: 'Q' },
        userId: user,
      }),
    );
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const newWave = (over: { reminderDays?: number[]; sendAt?: Date | null; name?: string } = {}) =>
    app.withTenant(a.id, (tx) =>
      cawi.createWave(tx, {
        tenantId: a.id,
        projectId: a.project,
        questionnaireId: q,
        name: over.name ?? `Wave ${randomUUID().slice(0, 4)}`,
        reminderDays: over.reminderDays ?? [],
        sendAt: over.sendAt,
        createdBy: user,
      }),
    );
  const makeCases = async (n: number, prefix: string) =>
    app.withTenant(a.id, (tx) =>
      cases.insertCases(tx, {
        tenantId: a.id,
        projectId: a.project,
        cases: Array.from({ length: n }, (_, i) => ({ externalId: `${prefix}-${stamp}-${i}` })),
      }),
    );
  const hash = () => randomUUID().replace(/-/g, '');
  /** Earlier tests leave invitations queued: put them aside so a lease sees only this test's. */
  const quiet = () =>
    owner((db) =>
      sql`UPDATE invitations SET status = 'failed' WHERE tenant_id = ${a.id} AND status = 'queued'`.execute(
        db,
      ),
    );
  const invite = (waveId: string, caseIds: string[], over: { status?: 'queued' | 'sent' } = {}) =>
    app.withTenant(a.id, (tx) =>
      cawi.addInvitations(tx, {
        tenantId: a.id,
        projectId: a.project,
        questionnaireId: q,
        waveId,
        rows: caseIds.map((caseId, i) => ({
          caseId,
          email: `p${i}-${caseId.slice(0, 6)}@example.org`,
          tokenHash: hash(),
          tokenEnc: 'enc',
          language: 'es',
          ...over,
        })),
      }),
    );

  it('keeps a template per project, kind and language, replacing it when saved again', async () => {
    const save = (subject: string) =>
      app.withTenant(a.id, (tx) =>
        cawi.saveTemplate(tx, {
          tenantId: a.id,
          projectId: a.project,
          kind: 'invitation',
          language: 'es',
          subject,
          body: 'Hola {{case.nombre}} {{link}}',
          userId: user,
        }),
      );
    await Promise.all([save('Uno'), save('Dos'), save('Tres')]);
    await app.withTenant(a.id, (tx) =>
      cawi.saveTemplate(tx, {
        tenantId: a.id,
        projectId: a.project,
        kind: 'reminder',
        language: 'es',
        subject: 'Recordatorio',
        body: 'x',
        userId: user,
      }),
    );
    const list = await app.withTenant(a.id, (tx) => cawi.templates(tx, a.project));
    expect(list.filter((t) => t.kind === 'invitation')).toHaveLength(1);
    expect(['Uno', 'Dos', 'Tres']).toContain(list.find((t) => t.kind === 'invitation')!.subject);
    expect(list.map((t) => t.kind)).toEqual(['invitation', 'reminder']);
  });

  it('invites each case once per wave, however many sends race', async () => {
    const wave = await newWave({ reminderDays: [7, 3] });
    expect((await app.withTenant(a.id, (tx) => cawi.wave(tx, wave)))!.reminder_days).toEqual([
      3, 7,
    ]);
    const ids = await makeCases(30, 'inv');
    expect(await invite(wave, ids.slice(0, 20))).toBe(20);
    expect(await invite(wave, ids.slice(10, 30))).toBe(10);
    const [x, y] = await Promise.all([
      invite(wave, ids.slice(0, 30)),
      invite(wave, ids.slice(0, 30)),
    ]);
    expect(x + y).toBe(0);
    // Another wave may invite the same cases.
    expect(await invite(await newWave(), ids.slice(0, 5))).toBe(5);
    const progress = (await app.withTenant(a.id, (tx) => cawi.waveProgress(tx, a.project))).find(
      (p) => p.id === wave,
    )!;
    expect(progress).toMatchObject({ invited: 30, sent: 0, completed: 0 });
  });

  it('refuses a token used twice', async () => {
    const wave = await newWave();
    const [c1, c2] = await makeCases(2, 'tok');
    const h = hash();
    const add = (caseId: string) =>
      app.withTenant(a.id, (tx) =>
        cawi.addInvitations(tx, {
          tenantId: a.id,
          projectId: a.project,
          questionnaireId: q,
          waveId: wave,
          rows: [{ caseId, email: 'x@example.org', tokenHash: h, tokenEnc: 'e', language: 'es' }],
        }),
      );
    await add(c1!);
    await expect(add(c2!)).rejects.toSatisfy(dup);
  });

  it('leases queued invitations oldest first, once, and takes them again when the lease runs out', async () => {
    await quiet();
    const wave = await newWave();
    const ids = await makeCases(6, 'lease');
    await invite(wave, ids);
    const now = new Date();
    const first = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now, limit: 4, leaseMs: 60_000 }),
    );
    expect(first.filter((l) => l.invitation.wave_id?.toLowerCase() === wave)).toHaveLength(4);
    expect(first.every((l) => l.kind === 'invitation')).toBe(true);
    // Another dispatcher gets what is left of this wave, none of the leased ones.
    const second = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now, limit: 10, leaseMs: 60_000 }),
    );
    const mine = second.filter((l) => l.invitation.wave_id?.toLowerCase() === wave);
    expect(mine).toHaveLength(2);
    expect(new Set([...first, ...second].map((l) => l.invitation.id)).size).toBe(
      first.length + second.length,
    );
    // The lease ran out (the worker was lost): they can be taken again.
    const later = new Date(now.getTime() + 120_000);
    const again = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now: later, limit: 100, leaseMs: 60_000 }),
    );
    expect(again.filter((l) => l.invitation.wave_id?.toLowerCase() === wave)).toHaveLength(6);
  });

  it('gives simultaneous dispatchers different invitations', async () => {
    await quiet();
    const wave = await newWave();
    const ids = await makeCases(12, 'race');
    await invite(wave, ids);
    const now = new Date();
    const takes = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.withTenant(a.id, (tx) => cawi.lease(tx, { now, limit: 3, leaseMs: 60_000 })),
      ),
    );
    const all = takes
      .flat()
      .filter((l) => l.invitation.wave_id?.toLowerCase() === wave)
      .map((l) => l.invitation.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('holds a wave back until its send time, and a disabled questionnaire sends nothing', async () => {
    await quiet();
    const future = await newWave({ sendAt: new Date(Date.now() + 3_600_000) });
    const [c] = await makeCases(1, 'future');
    await invite(future, [c!]);
    const held = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now: new Date(), limit: 100, leaseMs: 60_000 }),
    );
    expect(held.some((l) => l.invitation.wave_id?.toLowerCase() === future)).toBe(false);
    const released = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now: new Date(Date.now() + 7_200_000), limit: 100, leaseMs: 60_000 }),
    );
    expect(released.some((l) => l.invitation.wave_id?.toLowerCase() === future)).toBe(true);

    const q2 = await app.withTenant(a.id, (tx) =>
      questionnaires.create(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Off',
        draft: {},
        userId: user,
      }),
    );
    const w2 = await app.withTenant(a.id, (tx) =>
      cawi.createWave(tx, {
        tenantId: a.id,
        projectId: a.project,
        questionnaireId: q2,
        name: 'Off',
        createdBy: user,
      }),
    );
    const [c2] = await makeCases(1, 'off');
    await app.withTenant(a.id, (tx) =>
      cawi.addInvitations(tx, {
        tenantId: a.id,
        projectId: a.project,
        questionnaireId: q2,
        waveId: w2,
        rows: [
          { caseId: c2!, email: 'o@example.org', tokenHash: hash(), tokenEnc: 'e', language: 'es' },
        ],
      }),
    );
    await app.withTenant(a.id, (tx) => questionnaires.setState(tx, q2, 'disabled'));
    const none = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now: new Date(Date.now() + 7_200_000), limit: 100, leaseMs: 60_000 }),
    );
    expect(none.some((l) => l.invitation.wave_id?.toLowerCase() === w2)).toBe(false);
  });

  it('sends reminders when the days since the invitation have passed, not to the finished', async () => {
    await quiet();
    const wave = await newWave({ reminderDays: [3, 7] });
    const [done, waiting, finishedCase] = await makeCases(3, 'rem');
    await invite(wave, [done!, waiting!, finishedCase!]);
    const t0 = new Date('2026-11-02T10:00:00Z');
    const sent = await app.withTenant(a.id, (tx) =>
      cawi.lease(tx, { now: t0, limit: 100, leaseMs: 1000 }),
    );
    for (const l of sent.filter((s) => s.invitation.wave_id?.toLowerCase() === wave))
      await app.withTenant(a.id, async (tx) => {
        await cawi.markSent(tx, l.invitation.id, 'invitation');
      });
    // The send time is the invitation's: move it to the test's clock.
    await owner((db) =>
      sql`UPDATE invitations SET sent_at = ${t0.toISOString()} WHERE wave_id = ${wave}`.execute(db),
    );
    const inv = await app.withTenant(a.id, (tx) =>
      tx.selectFrom('invitations').select(['id', 'case_id']).where('wave_id', '=', wave).execute(),
    );
    const of = (caseId: string) => inv.find((i) => i.case_id?.toLowerCase() === caseId)!.id;
    await app.withTenant(a.id, (tx) => cawi.markCompleted(tx, of(done!), randomUUID()));
    await owner((db) =>
      sql`UPDATE cases SET status = 'finalised' WHERE id = ${finishedCase}`.execute(db),
    );
    const at = (days: number) => new Date(t0.getTime() + days * 86_400_000 + 60_000);
    const reminders = (days: number) =>
      app.withTenant(a.id, async (tx) =>
        (await cawi.lease(tx, { now: at(days), limit: 100, leaseMs: 1000 })).filter(
          (l) => l.invitation.wave_id?.toLowerCase() === wave,
        ),
      );
    expect(await reminders(2)).toHaveLength(0);
    const day3 = await reminders(3);
    expect(day3.map((l) => l.kind)).toEqual(['reminder']);
    expect(day3[0]!.invitation.id.toLowerCase()).toBe(of(waiting!));
    await app.withTenant(a.id, (tx) => cawi.markSent(tx, day3[0]!.invitation.id, 'reminder'));
    expect(await reminders(5)).toHaveLength(0);
    expect(await reminders(7)).toHaveLength(1);
    const row = await app.withTenant(a.id, (tx) => cawi.invitation(tx, of(waiting!)));
    expect(row).toMatchObject({ reminders_sent: 1, status: 'sent' });
    expect(row!.last_reminder_at).toBeInstanceOf(Date);
  });

  it('tracks opens, clicks and starts once, and completes an invitation with its interview', async () => {
    const wave = await newWave();
    const [c] = await makeCases(1, 'track');
    await invite(wave, [c!]);
    const id = (
      await app.withTenant(a.id, (tx) =>
        tx
          .selectFrom('invitations')
          .select('id')
          .where('wave_id', '=', wave)
          .executeTakeFirstOrThrow(),
      )
    ).id;
    await app.withTenant(a.id, (tx) => cawi.track(tx, id, 'opened'));
    const opened = (await app.withTenant(a.id, (tx) => cawi.invitation(tx, id)))!.opened_at;
    expect(opened).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 30));
    await app.withTenant(a.id, async (tx) => {
      await cawi.track(tx, id, 'opened');
      await cawi.track(tx, id, 'clicked');
      await cawi.track(tx, id, 'started');
    });
    const row = (await app.withTenant(a.id, (tx) => cawi.invitation(tx, id)))!;
    expect(row.opened_at!.getTime()).toBe(opened!.getTime());
    expect(row.clicked_at).toBeInstanceOf(Date);
    expect(row.started_at).toBeInstanceOf(Date);
    const interviewId = randomUUID();
    await app.withTenant(a.id, (tx) => cawi.markCompleted(tx, id, interviewId));
    expect(await app.withTenant(a.id, (tx) => cawi.invitation(tx, id))).toMatchObject({
      status: 'completed',
      interview_id: interviewId.toUpperCase(),
    });
  });

  it('counts failed sends and gives up after the last allowed attempt', async () => {
    const wave = await newWave();
    const [c] = await makeCases(1, 'fail');
    await invite(wave, [c!]);
    const id = (
      await app.withTenant(a.id, (tx) =>
        tx
          .selectFrom('invitations')
          .select('id')
          .where('wave_id', '=', wave)
          .executeTakeFirstOrThrow(),
      )
    ).id;
    for (const expected of ['queued', 'queued', 'failed'])
      await app.withTenant(a.id, async (tx) => {
        await cawi.markFailed(tx, id, 'SMTP 451', 3);
        expect((await cawi.invitation(tx, id))!.status).toBe(expected);
      });
    expect(await app.withTenant(a.id, (tx) => cawi.invitation(tx, id))).toMatchObject({
      send_attempts: 3,
      last_error: 'SMTP 451',
      lease_until: null,
    });
  });

  it('suppresses a bounced address for good, whatever its case', async () => {
    const wave = await newWave();
    const [c] = await makeCases(1, 'bounce');
    await app.withTenant(a.id, (tx) =>
      cawi.addInvitations(tx, {
        tenantId: a.id,
        projectId: a.project,
        questionnaireId: q,
        waveId: wave,
        rows: [
          {
            caseId: c!,
            email: `Bounce-${stamp}@Example.org`,
            tokenHash: hash(),
            tokenEnc: 'e',
            language: 'es',
          },
        ],
      }),
    );
    const id = (
      await app.withTenant(a.id, (tx) =>
        tx
          .selectFrom('invitations')
          .select('id')
          .where('wave_id', '=', wave)
          .executeTakeFirstOrThrow(),
      )
    ).id;
    expect(
      await app.withTenant(a.id, (tx) => cawi.bounce(tx, { tenantId: a.id, id, type: 'soft' })),
    ).toBe(true);
    expect((await app.withTenant(a.id, (tx) => cawi.invitation(tx, id)))!.status).toBe('queued');
    expect(
      await app.withTenant(a.id, (tx) => cawi.suppressed(tx, [`bounce-${stamp}@example.org`])),
    ).toEqual(new Set());
    await Promise.all(
      Array.from({ length: 3 }, () =>
        app.withTenant(a.id, (tx) => cawi.bounce(tx, { tenantId: a.id, id, type: 'hard' })),
      ),
    );
    expect(await app.withTenant(a.id, (tx) => cawi.invitation(tx, id))).toMatchObject({
      status: 'bounced',
      bounce_type: 'hard',
    });
    expect(
      await app.withTenant(a.id, (tx) =>
        cawi.suppressed(tx, [`BOUNCE-${stamp}@EXAMPLE.ORG`, 'other@example.org']),
      ),
    ).toEqual(new Set([`bounce-${stamp}@example.org`]));
    await app.withTenant(a.id, (tx) =>
      cawi.suppress(tx, {
        tenantId: a.id,
        email: `bounce-${stamp}@example.org`,
        reason: 'unsubscribe',
      }),
    );
    await app.withTenant(a.id, (tx) => cawi.unsuppress(tx, `bounce-${stamp}@example.org`));
    expect(
      await app.withTenant(a.id, (tx) => cawi.suppressed(tx, [`bounce-${stamp}@example.org`])),
    ).toEqual(new Set());
    expect(
      await app.withTenant(a.id, (tx) =>
        cawi.bounce(tx, { tenantId: a.id, id: randomUUID(), type: 'hard' }),
      ),
    ).toBe(false);
  });

  describe('lookups before any context', () => {
    it('finds the organisation of an invitation by its token, and nothing else', async () => {
      const wave = await newWave();
      const [c] = await makeCases(1, 'lookup');
      const h = hash();
      await app.withTenant(a.id, (tx) =>
        cawi.addInvitations(tx, {
          tenantId: a.id,
          projectId: a.project,
          questionnaireId: q,
          waveId: wave,
          rows: [
            { caseId: c!, email: 'l@example.org', tokenHash: h, tokenEnc: 'e', language: 'es' },
          ],
        }),
      );
      const seen = await app.withTenantOf('invitation_by_token', h, async (tx, found) => ({
        found,
        row: found ? await cawi.invitationByToken(tx, h) : undefined,
        others: (await tx.selectFrom('invitations').select('id').execute()).length,
      }));
      expect(seen.found).toMatchObject({ tenantId: a.id });
      expect(seen.row!.id.toLowerCase()).toBe(seen.found!.id);
      expect(seen.others).toBeGreaterThan(0);
      const none = await app.withTenantOf('invitation_by_token', 'nope', async (tx, found) => ({
        found,
        rows: await tx.selectFrom('invitations').select('id').execute(),
      }));
      expect(none).toEqual({ found: null, rows: [] });
    });

    it('finds an open link and a feedback point by slug, active ones only', async () => {
      const slug = `open-${stamp}`;
      const link = await app.withTenant(a.id, (tx) =>
        cawi.createOpenLink(tx, { tenantId: a.id, projectId: a.project, questionnaireId: q, slug }),
      );
      expect(await app.withTenantOf('open_link_by_slug', slug, async (_tx, f) => f)).toMatchObject({
        id: link,
        tenantId: a.id,
      });
      await app.withTenant(a.id, (tx) => cawi.setOpenLinkActive(tx, link, false));
      expect(await app.withTenantOf('open_link_by_slug', slug, async (_tx, f) => f)).toBeNull();
      await expect(
        app.withTenant(a.id, (tx) =>
          cawi.createOpenLink(tx, {
            tenantId: a.id,
            projectId: a.project,
            questionnaireId: q,
            slug,
          }),
        ),
      ).rejects.toSatisfy(dup);

      const pslug = `fb-${stamp}`;
      const point = await app.withTenant(a.id, (tx) =>
        cawi.createPoint(tx, {
          tenantId: a.id,
          projectId: a.project,
          name: 'Sala',
          question: { es: '¿Cómo fue?' },
          slug: pslug,
        }),
      );
      expect(
        await app.withTenantOf('feedback_point_by_slug', pslug, async (_tx, f) => f),
      ).toMatchObject({ id: point, tenantId: a.id });
      await app.withTenant(a.id, (tx) => cawi.updatePoint(tx, point, { active: false }));
      expect(
        await app.withTenantOf('feedback_point_by_slug', pslug, async (_tx, f) => f),
      ).toBeNull();
    });

    it('lists the organisations with mail waiting', async () => {
      const wave = await newWave();
      const [c] = await makeCases(1, 'due');
      await invite(wave, [c!]);
      const res = await sql<{ tenant_id: string }>`EXEC dbo.tenants_with_mail_due`.execute(app.db);
      expect(res.rows.map((r) => r.tenant_id.toLowerCase())).toContain(a.id);
    });
  });

  it('collects feedback: versions go up with the questions, a comment may be added once', async () => {
    const point = await app.withTenant(a.id, (tx) =>
      cawi.createPoint(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Caritas',
        question: { es: '¿Le atendieron bien?' },
        faces: 5,
        slug: `fbv-${stamp}`,
      }),
    );
    let p = await app.withTenant(a.id, (tx) => cawi.point(tx, point));
    expect(p).toMatchObject({ version: 1, faces: 5, active: true, ask_comment: true });
    expect(p!.question).toEqual({ es: '¿Le atendieron bien?' });
    await app.withTenant(a.id, (tx) => cawi.updatePoint(tx, point, { name: 'Caritas 2' }));
    expect((await app.withTenant(a.id, (tx) => cawi.point(tx, point)))!.version).toBe(1);
    await app.withTenant(a.id, (tx) =>
      cawi.updatePoint(tx, point, { items: [{ id: 'f1', type: 'text' }] }),
    );
    p = await app.withTenant(a.id, (tx) => cawi.point(tx, point));
    expect(p).toMatchObject({ version: 2 });
    expect(p!.items).toEqual([{ id: 'f1', type: 'text' }]);
    const add = (score: number, extra: object = {}) =>
      app.withTenant(a.id, (tx) =>
        cawi.addResponse(tx, { tenantId: a.id, pointId: point, score, ...extra }),
      );
    const r5 = await add(5, {
      editHash: 'key-1',
      channel: 'widget',
      ref: 'ticket-9',
      answers: { f1: 'bien' },
    });
    await add(5);
    await add(3);
    await add(1);
    expect(await app.withTenant(a.id, (tx) => cawi.scoreSummary(tx, point))).toEqual({
      total: 4,
      average: 3.5,
      byScore: { 1: 1, 3: 1, 5: 2 },
    });
    const comment = (key: string) =>
      app.withTenant(a.id, (tx) =>
        cawi.addCommentOnce(tx, { id: r5, editHash: key, comment: 'Todo bien' }),
      );
    expect(await comment('wrong')).toBe(false);
    expect(await comment('key-1')).toBe(true);
    expect(await comment('key-1')).toBe(false);
  });

  it('shows another organisation nothing, and refuses its writes', async () => {
    expect(await app.withTenant(b.id, (tx) => cawi.templates(tx, a.project))).toEqual([]);
    expect(await app.withTenant(b.id, (tx) => cawi.waveProgress(tx, a.project))).toEqual([]);
    expect(
      await app.withTenant(b.id, (tx) =>
        cawi.lease(tx, { now: new Date(Date.now() + 9e9), limit: 100, leaseMs: 1000 }),
      ),
    ).toEqual([]);
    await expect(
      app.withTenant(b.id, (tx) =>
        cawi.createWave(tx, {
          tenantId: a.id,
          projectId: a.project,
          questionnaireId: q,
          name: 'evil',
          createdBy: user,
        }),
      ),
    ).rejects.toThrow();
  });
});
