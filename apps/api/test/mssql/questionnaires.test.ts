import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import {
  DraftConflict,
  QuestionnaireStore,
} from '../../src/questionnaires/questionnaire-store.mssql.js';

/**
 * The questionnaire vertical on SQL Server (mssql/0002): drafts with compare-and-swap saves,
 * immutable versions, scenarios, comments, presence, the library, and isolation by organisation.
 * Runs only where a SQL Server is given (see isolation.test.ts).
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

describe.skipIf(!ADMIN || !APP)('SQL Server: questionnaires', () => {
  let app: MssqlDatabase;
  const store = new QuestionnaireStore();
  const stamp = Date.now().toString(36);
  const a = { id: randomUUID(), slug: `qa-${stamp}`, project: randomUUID() };
  const b = { id: randomUUID(), slug: `qb-${stamp}`, project: randomUUID() };
  const user = randomUUID();
  const draft = (title: string) => ({ title, items: [{ id: 'q1', type: 'text' }] });

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 6 });
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      for (const t of [a, b]) {
        await sql`INSERT INTO tenants (id, name, slug) VALUES (${t.id}, ${t.slug}, ${t.slug})`.execute(
          owner,
        );
        await sql`INSERT INTO projects (id, tenant_id, name, code) VALUES (${t.project}, ${t.id}, 'P', ${'P-' + stamp})`.execute(
          owner,
        );
      }
    } finally {
      await owner.destroy();
    }
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const create = (t: typeof a, name: string) =>
    app.withTenant(t.id, (tx) =>
      store.create(tx, {
        tenantId: t.id,
        projectId: t.project,
        name,
        draft: draft(name),
        userId: user,
      }),
    );

  it('creates, reads and lists a questionnaire with its draft as JSON', async () => {
    const id = await create(a, 'Encuesta 1');
    const q = await app.withTenant(a.id, (tx) => store.get(tx, a.project, id));
    expect(q).toMatchObject({ name: 'Encuesta 1', state: 'active', draft_revision: 1 });
    expect(q!.draft).toEqual(draft('Encuesta 1'));
    const list = await app.withTenant(a.id, (tx) => store.list(tx, a.project));
    expect(list.map((r) => r.id.toLowerCase())).toContain(id);
  });

  it('saves a draft only from the revision that was read, and says who got there first', async () => {
    const id = await create(a, 'CAS');
    const saved = await app.withTenant(a.id, (tx) =>
      store.saveDraft(tx, id, { baseRevision: 1, draft: draft('v2'), userId: user, name: 'CAS 2' }),
    );
    expect(saved.draftRevision).toBe(2);
    const stale = await app
      .withTenant(a.id, (tx) =>
        store.saveDraft(tx, id, { baseRevision: 1, draft: draft('late'), userId: user }),
      )
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(DraftConflict);
    expect((stale as DraftConflict).current.draftRevision).toBe(2);
    const q = await app.withTenant(a.id, (tx) => store.get(tx, a.project, id));
    expect(q).toMatchObject({ name: 'CAS 2', draft_revision: 2 });

    // Six saves from the same revision at once: one wins, five conflict.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        app.withTenant(a.id, (tx) =>
          store.saveDraft(tx, id, { baseRevision: 2, draft: draft(`r${i}`), userId: user }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DraftConflict);
    expect((await app.withTenant(a.id, (tx) => store.get(tx, a.project, id)))!.draft_revision).toBe(
      3,
    );
  });

  it('numbers versions one after another when publishes race, under the draft’s row lock', async () => {
    const id = await create(a, 'Publish');
    const publish = (n: number) =>
      app.withTenant(a.id, async (tx) => {
        await store.lockDraft(tx, a.project, id);
        return store.publish(tx, {
          tenantId: a.id,
          questionnaireId: id,
          definition: draft(`d${n}`),
          compiled: { hash: `h${n}-${randomUUID()}` },
          mapping: n === 2 ? { q1: 'q1' } : null,
          userId: user,
        });
      });
    const published = await Promise.all([publish(1), publish(2), publish(3)]);
    expect(published.map((p) => p.version).sort()).toEqual([1, 2, 3]);
    const versions = await app.withTenant(a.id, (tx) => store.versions(tx, id));
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    const latest = await app.withTenant(a.id, (tx) => store.latestVersion(tx, id));
    expect(latest).toMatchObject({ version: 3, status: 'published' });
    // The versions are numbered in the order the lock was won; each keeps its own content.
    const callOfVersion3 = published.findIndex((p) => p.version === 3) + 1;
    expect(latest!.definition).toEqual(draft(`d${callOfVersion3}`));
  });

  it('keeps published versions immutable: only published to retired, nothing deleted', async () => {
    const id = await create(a, 'Immutable');
    await app.withTenant(a.id, (tx) =>
      store.publish(tx, {
        tenantId: a.id,
        questionnaireId: id,
        definition: draft('x'),
        compiled: { hash: 'hx' },
        mapping: null,
        userId: user,
      }),
    );
    // The definition cannot change, even for the application user who may update the row.
    await expect(
      app.withTenant(a.id, (tx) =>
        tx
          .updateTable('questionnaire_versions')
          .set({ definition: '{"title":"edited"}' })
          .where('questionnaire_id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      app.withTenant(a.id, (tx) =>
        tx
          .updateTable('questionnaire_versions')
          .set({ hash: 'other' })
          .where('questionnaire_id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow(/immutable/);
    // No privilege to delete for the application; a trigger stops the owner.
    await expect(
      app.withTenant(a.id, (tx) =>
        sql`DELETE FROM questionnaire_versions WHERE questionnaire_id = ${id}`.execute(tx),
      ),
    ).rejects.toThrow(/permission was denied/i);
    const owner = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1 });
    try {
      await expect(
        sql`DELETE FROM questionnaire_versions WHERE questionnaire_id = ${id}`.execute(owner),
      ).rejects.toThrow(/cannot be deleted/);
    } finally {
      await owner.destroy();
    }
    // Retiring is allowed once; going back is not.
    await app.withTenant(a.id, (tx) => store.retire(tx, id, 1));
    const retired = await app.withTenant(a.id, (tx) => store.latestVersion(tx, id));
    expect(retired).toMatchObject({ status: 'retired' });
    expect(retired!.retired_at).toBeInstanceOf(Date);
    await expect(
      app.withTenant(a.id, (tx) =>
        tx
          .updateTable('questionnaire_versions')
          .set({ status: 'published' })
          .where('questionnaire_id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow(/published to retired/);
  });

  it('keeps scenarios by name, replacing one saved again', async () => {
    const id = await create(a, 'Scenarios');
    const save = (name: string, scenario: unknown) =>
      app.withTenant(a.id, (tx) =>
        store.saveScenario(tx, {
          tenantId: a.id,
          questionnaireId: id,
          name,
          scenario,
          userId: user,
        }),
      );
    await save('b', { answers: { q1: 'x' } });
    await save('a', { answers: {} });
    await save('b', { answers: { q1: 'y' } });
    const list = await app.withTenant(a.id, (tx) => store.scenarios(tx, id));
    expect(list.map((s) => s.name)).toEqual(['a', 'b']);
    expect(list[1]!.scenario).toEqual({ answers: { q1: 'y' } });
    await app.withTenant(a.id, (tx) => store.deleteScenario(tx, id, list[0]!.id));
    expect(await app.withTenant(a.id, (tx) => store.scenarios(tx, id))).toHaveLength(1);
  });

  it('resolves a comment thread but not a reply', async () => {
    const id = await create(a, 'Comments');
    const root = await app.withTenant(a.id, (tx) =>
      store.addComment(tx, {
        tenantId: a.id,
        questionnaireId: id,
        itemId: 'q1',
        parentId: null,
        authorId: user,
        body: '¿Y esta pregunta?',
      }),
    );
    const reply = await app.withTenant(a.id, (tx) =>
      store.addComment(tx, {
        tenantId: a.id,
        questionnaireId: id,
        itemId: 'q1',
        parentId: root,
        authorId: user,
        body: 'Sí',
      }),
    );
    await app.withTenant(a.id, (tx) => store.resolveThread(tx, reply, user, true));
    await app.withTenant(a.id, (tx) => store.resolveThread(tx, root, user, true));
    const rows = await app.withTenant(a.id, (tx) => store.comments(tx, id));
    const byBody = Object.fromEntries(rows.map((r) => [r.body, r.resolved_at !== null]));
    expect(byBody).toEqual({ '¿Y esta pregunta?': true, Sí: false });
  });

  it('keeps one presence row per person, however many heartbeats arrive together', async () => {
    const id = await create(a, 'Presence');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.withTenant(a.id, (tx) =>
          store.touchPresence(tx, {
            tenantId: a.id,
            questionnaireId: id,
            userId: user,
            itemId: `q${i}`,
          }),
        ),
      ),
    );
    const seen = await app.withTenant(a.id, (tx) => store.presence(tx, id));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.user_id.toLowerCase()).toBe(user);
    expect(await app.withTenant(a.id, (tx) => store.presence(tx, id, 0))).toHaveLength(0);
  });

  it('searches the library by name (with wildcard characters taken literally) and by tag', async () => {
    const save = (name: string, tags: string[]) =>
      app.withTenant(a.id, (tx) =>
        store.saveLibraryItem(tx, {
          tenantId: a.id,
          name,
          description: null,
          tags,
          content: { type: 'text' },
          languages: ['es'],
          userId: user,
        }),
      );
    await save(`Bloque 100% ${stamp}`, ['salud']);
    await save(`Bloque ${stamp} otro`, ['hogar', 'salud']);
    const byText = await app.withTenant(a.id, (tx) =>
      store.searchLibrary(tx, { text: `100% ${stamp}` }),
    );
    expect(byText.map((r) => r.name)).toEqual([`Bloque 100% ${stamp}`]);
    const wildcard = await app.withTenant(a.id, (tx) => store.searchLibrary(tx, { text: '%' }));
    expect(wildcard.map((r) => r.name)).toEqual([`Bloque 100% ${stamp}`]);
    const byTag = await app.withTenant(a.id, (tx) => store.searchLibrary(tx, { tag: 'hogar' }));
    expect(byTag.map((r) => r.name)).toEqual([`Bloque ${stamp} otro`]);
    expect(byTag[0]!.tags).toEqual(['hogar', 'salud']);
    expect(byTag[0]!.languages).toEqual(['es']);
    for (const r of await app.withTenant(a.id, (tx) => store.searchLibrary(tx, { tag: 'salud' })))
      await app.withTenant(a.id, (tx) => store.deleteLibraryItem(tx, r.id));
    expect(await app.withTenant(a.id, (tx) => store.searchLibrary(tx, { tag: 'salud' }))).toEqual(
      [],
    );
  });

  it('deletes only a questionnaire never published, with its scenarios, comments and presence', async () => {
    const id = await create(a, 'To delete');
    await app.withTenant(a.id, (tx) =>
      store.saveScenario(tx, {
        tenantId: a.id,
        questionnaireId: id,
        name: 's',
        scenario: {},
        userId: user,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      store.addComment(tx, {
        tenantId: a.id,
        questionnaireId: id,
        itemId: null,
        parentId: null,
        authorId: user,
        body: 'c',
      }),
    );
    await app.withTenant(a.id, (tx) =>
      store.touchPresence(tx, { tenantId: a.id, questionnaireId: id, userId: user, itemId: null }),
    );
    await app.withTenant(a.id, (tx) => store.deleteUnpublished(tx, id));
    expect(await app.withTenant(a.id, (tx) => store.get(tx, a.project, id))).toBeUndefined();

    const kept = await create(a, 'Published');
    await app.withTenant(a.id, (tx) =>
      store.publish(tx, {
        tenantId: a.id,
        questionnaireId: kept,
        definition: draft('p'),
        compiled: { hash: 'hp' },
        mapping: null,
        userId: user,
      }),
    );
    await expect(app.withTenant(a.id, (tx) => store.deleteUnpublished(tx, kept))).rejects.toThrow(
      /cannot be deleted/,
    );
    expect(await app.withTenant(a.id, (tx) => store.get(tx, a.project, kept))).toBeDefined();
  });

  it('completes a questionnaire with a successor, and reactivating clears it', async () => {
    const first = await create(a, 'Old');
    const next = await create(a, 'New');
    await app.withTenant(a.id, (tx) => store.setState(tx, first, 'completed', next));
    let q = await app.withTenant(a.id, (tx) => store.get(tx, a.project, first));
    expect(q).toMatchObject({ state: 'completed' });
    expect(q!.successor_id?.toLowerCase()).toBe(next);
    expect(q!.state_changed_at).toBeInstanceOf(Date);
    await app.withTenant(a.id, (tx) => store.setState(tx, first, 'active'));
    q = await app.withTenant(a.id, (tx) => store.get(tx, a.project, first));
    expect(q).toMatchObject({ state: 'active', successor_id: null });
  });

  it('shows another organisation nothing, and refuses its writes', async () => {
    const id = await create(a, 'Private');
    expect(await app.withTenant(b.id, (tx) => store.get(tx, a.project, id))).toBeUndefined();
    expect(await app.withTenant(b.id, (tx) => store.list(tx, a.project))).toEqual([]);
    await expect(
      app.withTenant(b.id, (tx) =>
        store.create(tx, {
          tenantId: a.id,
          projectId: a.project,
          name: 'x',
          draft: {},
          userId: user,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      app.withTenant(b.id, (tx) =>
        store.saveDraft(tx, id, { baseRevision: 1, draft: {}, userId: user }),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect((await app.withTenant(a.id, (tx) => store.get(tx, a.project, id)))!.draft_revision).toBe(
      1,
    );
  });
});
