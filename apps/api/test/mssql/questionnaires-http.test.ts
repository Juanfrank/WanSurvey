import { household, SAMPLES } from '@wansurvey/fixtures';
import type { QuestionnaireInput } from '@wansurvey/schema';
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

/** A small questionnaire: A (single 1/2), B (numeric, asked only if A == 1). */
function small(extra: { codes?: number[]; bName?: string } = {}): QuestionnaireInput {
  const codes = extra.codes ?? [1, 2];
  return {
    id: 'SMALL',
    title: { en: 'Small' },
    defaultLanguage: 'en',
    languages: ['en'],
    sections: [
      {
        id: 'S1',
        title: { en: 'S1' },
        items: [
          {
            kind: 'question',
            id: 'A',
            name: 'A',
            type: 'single',
            text: { en: 'A?' },
            options: codes.map((c) => ({ code: c, label: { en: `Code ${c}` } })),
          },
          {
            kind: 'question',
            id: extra.bName ?? 'B',
            name: extra.bName ?? 'B',
            type: 'numeric',
            text: { en: 'B?' },
            showIf: 'A == 1',
          },
        ],
      },
    ],
  };
}

/** Questionnaires over HTTP on SQL Server: drafts, publishing, versions (test/questionnaires.test.ts). */
describe.skipIf(!configured)('SQL Server: questionnaires over HTTP', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  let pm: Session;
  let pm2: Session;
  let base: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    project = await createProject(t.owner, tenant.id);
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    pm2 = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager' }]),
      tenant.slug,
    );
    base = `/api/v1/projects/${project}/questionnaires`;
  });
  afterAll(async () => {
    await t?.close();
  });
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await q.execute(t.owner)) as { rows: Record<string, unknown>[] }).rows;

  const post = (s: Session, path: string, body: object = {}) =>
    s.agent.post(path).set('x-csrf-token', s.csrf).send(body);
  const put = (s: Session, path: string, body: object) =>
    s.agent.put(path).set('x-csrf-token', s.csrf).send(body);

  const ALL_MODES = ['CATI', 'CAPI', 'CAWI', 'PAPI'];
  async function create(definition: QuestionnaireInput = small()) {
    const res = await post(pm, base, {
      modes: ALL_MODES,
      name: 'Small',
      source: { kind: 'json', definition },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; draftRevision: number };
  }

  it('takes its modes at creation, within the project’s modes (Q1)', async () => {
    expect((await post(pm, base, { name: 'No modes' })).status).toBe(400);
    expect((await post(pm, base, { name: 'Twice', modes: ['CATI', 'CATI'] })).status).toBe(400);
    const web = await post(pm, base, {
      name: 'Web only',
      modes: ['CAWI'],
      source: { kind: 'sample', id: SAMPLES[0]!.id },
    });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    expect(web.body.draft.modes).toEqual(['CAWI']);
    const list = await pm.agent.get(base).expect(200);
    expect(list.body.find((q: { id: string }) => q.id === web.body.id).modes).toEqual(['CAWI']);
    await sql`UPDATE projects SET modes_enabled = ${JSON.stringify(['CATI', 'CAWI'])} WHERE id = ${project}`.execute(
      t.owner,
    );
    const refused = await post(pm, base, { name: 'Paper', modes: ['CATI', 'PAPI'] });
    expect(refused.body).toMatchObject({ code: 'MODES_NOT_IN_PROJECT', modes: ['PAPI'] });
    await sql`UPDATE projects SET modes_enabled = '[]' WHERE id = ${project}`.execute(t.owner);
  });

  it('creates from blank, a sample or JSON and lists them', async () => {
    const blank = await post(pm, base, { modes: ALL_MODES, name: 'Blank one' });
    expect(blank.status).toBe(201);
    expect(blank.body.draft.sections).toHaveLength(1);
    // New questionnaires are in Spanish; other languages are added later.
    expect(blank.body.draft).toMatchObject({
      title: { es: 'Blank one' },
      defaultLanguage: 'es',
      languages: ['es'],
    });
    expect(blank.body.draftRevision).toBe(1);

    const sample = await post(pm, base, {
      modes: ALL_MODES,
      name: 'Household',
      source: { kind: 'sample', id: 'household' },
    });
    expect(sample.body.draft.id).toBe(household.id);
    expect(
      (
        await post(pm, base, {
          modes: ALL_MODES,
          name: 'x',
          source: { kind: 'sample', id: 'nope' },
        })
      ).status,
    ).toBe(404);

    const list = await pm.agent.get(base);
    expect(list.status).toBe(200);
    expect(list.body.map((q: { name: string }) => q.name)).toEqual(
      expect.arrayContaining(['Blank one', 'Household']),
    );
    expect(list.body[0].latestVersion).toBeNull();
  });

  it('saves drafts with optimistic locking, keeping invalid work', async () => {
    const q = await create();
    const url = `${base}/${q.id}/draft`;
    const broken = { ...small(), sections: [] };
    const saved = await put(pm, url, { definition: broken, baseRevision: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.draftRevision).toBe(2);
    expect(saved.body.diagnostics.length).toBeGreaterThan(0);

    // Someone still on revision 1 is told who saved in the meantime.
    const stale = await put(pm2, url, { definition: small(), baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('DRAFT_CONFLICT');
    expect(stale.body.currentRevision).toBe(2);
    expect(stale.body.updatedBy).toMatch(/@example\.org$/);

    const overwrite = await put(pm2, url, {
      definition: small(),
      baseRevision: 2,
      name: 'Renamed',
    });
    expect(overwrite.status).toBe(200);
    expect(overwrite.body.diagnostics).toEqual([]);
    const got = await pm.agent.get(`${base}/${q.id}`);
    expect(got.body).toMatchObject({ name: 'Renamed', draftRevision: 3 });
  });

  it('audits draft saves at most once per editor in five minutes', async () => {
    const q = await create();
    for (let r = 1; r <= 3; r++) {
      expect(
        (await put(pm, `${base}/${q.id}/draft`, { definition: small(), baseRevision: r })).status,
      ).toBe(200);
    }
    const saves = await rows(sql`SELECT COUNT(*) AS n FROM audit_log
      WHERE target_id = ${q.id} AND action = 'questionnaire.draft_saved'`);
    expect(Number(saves[0]!.n)).toBe(1);
  });

  it('renames, and deletes only what was never published', async () => {
    const q = await create();
    const url = `${base}/${q.id}`;
    const patch = (path: string, body: object) =>
      pm.agent.patch(path).set('x-csrf-token', pm.csrf).send(body);
    const del = (path: string) => pm.agent.delete(path).set('x-csrf-token', pm.csrf);
    expect((await patch(url, { name: '  ' })).status).toBe(400);
    const renamed = await patch(url, { name: 'Renamed' });
    expect(renamed.body).toMatchObject({ id: q.id, name: 'Renamed' });
    expect((await pm.agent.get(url)).body.name).toBe('Renamed');

    // Published: refused.
    const used = await create();
    await post(pm, `${base}/${used.id}/publish`, { baseRevision: used.draftRevision }).expect(201);
    const refused = await del(`${base}/${used.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IN_USE');

    // Never published: gone, with its scenarios.
    const scen = await put(pm, `${url}/scenarios`, {
      scenario: { name: 'One', mode: 'CATI', steps: [], expect: {} },
    });
    expect(scen.status, JSON.stringify(scen.body)).toBe(200);
    expect((await del(url)).status).toBe(204);
    expect((await pm.agent.get(url)).status).toBe(404);
    const left = await rows(
      sql`SELECT COUNT(*) AS n FROM questionnaire_scenarios WHERE questionnaire_id = ${q.id}`,
    );
    expect(Number(left[0]!.n)).toBe(0);
  });

  it('publishes, blocks on errors, failing scenarios, missing mappings and no changes', async () => {
    const q = await create();
    const url = `${base}/${q.id}`;
    let rev = q.draftRevision;
    const save = async (definition: unknown) => {
      const r = await put(pm, `${url}/draft`, { definition, baseRevision: rev });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      rev = r.body.draftRevision;
    };

    // Analyzer error: unknown variable.
    const bad = small();
    (bad.sections[0]!.items[1] as { showIf?: string }).showIf = 'NOPE == 1';
    await save(bad);
    const check = await post(pm, `${url}/publish-check`);
    expect(check.body.ok).toBe(false);
    expect(check.body.diagnostics.some((d: { severity: string }) => d.severity === 'error')).toBe(
      true,
    );
    const blocked = await post(pm, `${url}/publish`, { baseRevision: rev });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PUBLISH_BLOCKED');

    // A saved scenario must pass.
    await save(small());
    const scen = await put(pm, `${url}/scenarios`, {
      scenario: {
        name: 'A=2 skips B',
        mode: 'CATI',
        steps: [{ answer: 'A', value: 2 }],
        expect: { pathExcludes: ['B'] },
      },
    });
    expect(scen.status).toBe(200);
    const wrong = await put(pm, `${url}/scenarios`, {
      scenario: {
        name: 'wrong',
        mode: 'CATI',
        steps: [{ answer: 'A', value: 2 }],
        expect: { pathIncludes: ['B'] },
      },
    });
    const failing = await post(pm, `${url}/publish-check`);
    expect(failing.body.scenarios.map((s: { passed: boolean }) => s.passed)).toEqual([true, false]);
    expect((await post(pm, `${url}/publish`, { baseRevision: rev })).status).toBe(422);
    expect(
      (await pm.agent.delete(`${url}/scenarios/${wrong.body.id}`).set('x-csrf-token', pm.csrf))
        .status,
    ).toBe(204);

    // Publishing an older revision than the draft is refused.
    expect((await post(pm, `${url}/publish`, { baseRevision: rev - 1 })).body.code).toBe(
      'DRAFT_CONFLICT',
    );
    const v1 = await post(pm, `${url}/publish`, { baseRevision: rev });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect(v1.body.version).toBe(1);

    expect((await post(pm, `${url}/publish`, { baseRevision: rev })).body.code).toBe(
      'NOTHING_TO_PUBLISH',
    );

    // Code 2 removed and B renamed to B2: both need a mapping.
    await save(small({ codes: [1, 3], bName: 'B2' }));
    // The scenario still refers to code 2; replace it.
    await put(pm, `${url}/scenarios`, {
      scenario: {
        name: 'A=2 skips B',
        mode: 'CATI',
        steps: [{ answer: 'A', value: 3 }],
        expect: { pathExcludes: ['B2'] },
      },
    });
    const needs = await post(pm, `${url}/publish-check`);
    expect(needs.body.breaking.map((b: { id: string }) => b.id).sort()).toEqual([
      'codes:A',
      'removed:B',
    ]);
    expect(needs.body.mappingProblems).toHaveLength(2);
    expect((await post(pm, `${url}/publish`, { baseRevision: rev })).status).toBe(422);

    const mapping = {
      'codes:A': { action: 'recode', map: { '2': 3 } },
      'removed:B': { action: 'rename', to: 'B2' },
    };
    const ok = await post(pm, `${url}/publish-check`, { mapping });
    expect(ok.body.ok).toBe(true);
    const v2 = await post(pm, `${url}/publish`, { baseRevision: rev, mapping });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body.version).toBe(2);

    const versions = await pm.agent.get(`${url}/versions`);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions.body[0].hasMapping).toBe(true);
    const full = await pm.agent.get(`${url}/versions/2`);
    expect(full.body.mapping).toEqual(mapping);
    expect(full.body.compiled.hash).toBe(full.body.hash);

    const audit = await rows(sql`SELECT details FROM audit_log
      WHERE target_id = ${q.id} AND action = 'questionnaire.published' ORDER BY at, id`);
    expect(
      audit.map((a) => (JSON.parse(a.details as string) as { version: number }).version),
    ).toEqual([1, 2]);
  });

  it('retires versions; published versions cannot be changed or deleted', async () => {
    const qid = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    const url = `${base}/${qid}/versions/1`;
    const r = await post(pm, `${url}/retire`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('retired');
    expect((await post(pm, `${url}/retire`)).status).toBe(404);

    await expect(
      sql`UPDATE questionnaire_versions SET hash = 'x' WHERE questionnaire_id = ${qid}`.execute(
        t.owner,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`UPDATE questionnaire_versions SET status = 'published' WHERE questionnaire_id = ${qid}`.execute(
        t.owner,
      ),
    ).rejects.toThrow(/published to retired|immutable/);
    await expect(
      sql`DELETE FROM questionnaire_versions WHERE questionnaire_id = ${qid}`.execute(t.owner),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('copies a published version into a new questionnaire', async () => {
    const qid = await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    const copy = await post(pm, base, {
      modes: ALL_MODES,
      name: 'Copy',
      source: { kind: 'version', questionnaireId: qid, version: 1 },
    });
    expect(copy.status).toBe(201);
    expect(copy.body.draft.id).toBe(household.id);
  });

  it('keeps questionnaires inside their project and tenant', async () => {
    const qid = await createQuestionnaire(t.owner, tenant.id, project);
    const otherProject = await createProject(t.owner, tenant.id);
    expect(
      (await pm.agent.get(`/api/v1/projects/${otherProject}/questionnaires/${qid}`)).status,
    ).toBe(404);

    const other = await createTenant(t.owner);
    const outsider = await login(
      t,
      await createUser(t.owner, other.id, [{ role: 'project_manager' }]),
      other.slug,
    );
    expect((await outsider.agent.get(`${base}/${qid}`)).status).toBe(404);
    expect((await outsider.agent.get(base)).status).toBe(404);
  });
});
