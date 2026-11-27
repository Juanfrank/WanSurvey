import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  configured,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

const DAY = 86_400_000;
const NEWID = '8c3b2e4a-7d9f-4a01-9c2d-3e4f5a6b7c8d';

const PROJECT = '6a1f0c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const CASE = '7b2a1d3f-6c8e-4f90-8b1c-2d3e4f5a6b7c';

/**
 * Audit log: the screen's filters (presets, project, case) and paging, and the export:
 * permission, content, formula safety, range cap, its own trail, isolation.
 */
describe.skipIf(!configured)('SQL Server: audit log export', () => {
  let t: MssqlTestApp;
  let tenant: { id: string; slug: string };
  let owner: Session;
  let admin: Session;
  let range: { from: string; to: string };

  const get = (s: Session, query: Record<string, string>) =>
    s.agent
      .get('/api/v1/audit-log/export')
      .query(query)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => cb(null, data));
      });

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.owner);
    const o = await createUser(t.owner, tenant.id, [{ role: 'owner' }]);
    const a = await createUser(t.owner, tenant.id, [{ role: 'admin' }]);
    owner = await login(t, o, tenant.slug);
    admin = await login(t, a, tenant.slug);
    const now = Date.now();
    range = {
      from: new Date(now - DAY).toISOString(),
      to: new Date(now + DAY).toISOString(),
    };
    // A value a spreadsheet would run as a formula, planted in the log.
    await sql`INSERT INTO audit_log (id, tenant_id, action, target_type, target_id, details)
              VALUES (NEWID(), ${tenant.id}, 'project.created', 'project', '=HYPERLINK("x")', '{}')`.execute(
      t.owner,
    );
    // Entries about one project and one of its cases, as the API records them.
    const plant = (action: string, targetType: string, targetId: string, details: object) =>
      sql`INSERT INTO audit_log (id, tenant_id, action, target_type, target_id, details)
          VALUES (NEWID(), ${tenant.id}, ${action}, ${targetType}, ${targetId},
                  ${JSON.stringify(details)})`.execute(t.owner);
    await plant('project.updated', 'project', PROJECT, {});
    await plant('interview.corrected', 'interview', NEWID, {
      variable: 'A2_AGE',
      projectId: PROJECT,
      caseId: CASE,
      externalId: 'HH0004',
    });
    await plant('case.pii_viewed', 'case', CASE, { projectId: PROJECT, externalId: 'HH0004' });
    await plant('data.downloaded', 'export', NEWID, { projectId: PROJECT });
  });
  afterAll(async () => {
    await t?.close();
  });

  const list = async (query: Record<string, string | number>) => {
    const res = await owner.agent.get('/api/v1/audit-log').query(query);
    expect(res.status).toBe(200);
    return res.body as { id: string; action: string; at: string }[];
  };

  it('filters by a set of actions, a project and a case', async () => {
    const presets = await list({ actions: 'interview.corrected,data.downloaded' });
    expect(presets.map((r) => r.action).sort()).toEqual(['data.downloaded', 'interview.corrected']);
    const project = await list({ projectId: PROJECT });
    expect(project.map((r) => r.action).sort()).toEqual([
      'case.pii_viewed',
      'data.downloaded',
      'interview.corrected',
      'project.updated',
    ]);
    // By the case's code or its id, as target or in the details.
    for (const caseRef of ['hh0004', CASE.toUpperCase()])
      expect((await list({ caseRef })).map((r) => r.action).sort()).toEqual([
        'case.pii_viewed',
        'interview.corrected',
      ]);
    expect(
      (await list({ caseRef: 'HH0004', actions: 'interview.corrected' })).map((r) => r.action),
    ).toEqual(['interview.corrected']);
  });

  it('pages newest first with no gaps or repeats', async () => {
    const all = await list({ limit: 500 });
    expect(all.length).toBeGreaterThan(4);
    const seen: string[] = [];
    let before: { at: string; id: string } | null = null;
    for (;;) {
      const page = await list({
        limit: 2,
        ...(before ? { beforeAt: before.at, beforeId: before.id } : {}),
      });
      seen.push(...page.map((r) => r.id));
      if (page.length < 2) break;
      before = { at: page[1]!.at, id: page[1]!.id };
    }
    expect(seen).toEqual(all.map((r) => r.id));
    expect(
      (await owner.agent.get('/api/v1/audit-log').query({ beforeAt: all[0]!.at })).status,
    ).toBe(400);
  });

  it('exports only what the filters select', async () => {
    const res = await get(owner, { ...range, format: 'jsonl', caseRef: 'HH0004' });
    const lines = (res.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { action: string });
    expect(lines.map((l) => l.action).sort()).toEqual(['case.pii_viewed', 'interview.corrected']);
  });

  it('is for owners only by default', async () => {
    expect((await get(admin, range)).status).toBe(403);
    expect((await get(owner, range)).status).toBe(200);
  });

  it('writes CSV that cannot run as a formula', async () => {
    const res = await get(owner, range);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('audit-log.csv');
    const text = res.body as string;
    expect(text).toContain('project.created');
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toMatch(/,=HYPERLINK/);
  });

  it('writes JSON lines, one entry per line', async () => {
    const res = await get(owner, { ...range, format: 'jsonl', action: 'project.created' });
    const lines = (res.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.action === 'project.created')).toBe(true);
  });

  it('refuses an inverted or too long range', async () => {
    expect((await get(owner, { from: range.to, to: range.from })).status).toBe(400);
    const long = { from: new Date(Date.now() - 400 * DAY).toISOString(), to: range.to };
    expect((await get(owner, long)).status).toBe(400);
    expect((await get(owner, {})).status).toBe(400);
  });

  it('logs each export, at the start and at the end with the row count', async () => {
    await get(owner, range);
    const res = await sql<{ details: string }>`
      SELECT details FROM audit_log
      WHERE tenant_id = ${tenant.id} AND action = 'audit.exported' ORDER BY at, id`.execute(
      t.owner,
    );
    const phases = res.rows.map((r) => JSON.parse(r.details) as { phase: string; rows?: number });
    expect(phases.at(-2)?.phase).toBe('started');
    expect(phases.at(-1)?.phase).toBe('completed');
    expect(phases.at(-1)?.rows).toBeGreaterThan(0);
  });

  it('never includes another organisation', async () => {
    const other = await createTenant(t.owner);
    const o2 = await createUser(t.owner, other.id, [{ role: 'owner' }]);
    const s = await login(t, o2, other.slug);
    const res = await get(s, range);
    expect(res.status).toBe(200);
    expect(res.body as string).not.toContain(tenant.id);
    expect(res.body as string).not.toContain('=HYPERLINK');
  });
});
