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

/** Audit-log export: permission, content, formula safety, range cap, its own trail, isolation. */
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
  });
  afterAll(async () => {
    await t?.close();
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
