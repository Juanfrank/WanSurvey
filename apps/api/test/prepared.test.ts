import { eq, getTableColumns, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, Prepared } from '../src/db/database.js';
import { projects } from '../src/db/schema.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  type TestApp,
} from './harness.js';

/** The hot paths' building blocks: one-transaction lookups and queries built once. */
describe('prepared queries and one-transaction lookups', () => {
  let t: TestApp;
  let tenant: { id: string };
  let project: string;

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    await t.admin`update projects set settings = ${t.admin.json({ cawi: { theme: { corners: 'square' } } } as never)},
                  logo_updated_at = now() where id = ${project}`;
  });
  afterAll(() => t.close());

  it('gives the same row as Drizzle, decoded the same way, run after run', async () => {
    const db = t.app.get(Database);
    const byId = new Prepared<typeof projects.$inferSelect>(
      (tx) =>
        tx
          .select()
          .from(projects)
          .where(eq(projects.id, sql.placeholder('id'))),
      getTableColumns(projects),
    );
    await db.withTenant(tenant.id, async (tx) => {
      const [drizzled] = await tx.select().from(projects).where(eq(projects.id, project));
      for (let i = 0; i < 3; i++) {
        const [mine] = await byId.run(tx, { id: project });
        expect(mine).toEqual(drizzled);
        expect(mine!.logoUpdatedAt).toBeInstanceOf(Date);
        expect(mine!.settings).toMatchObject({ cawi: { theme: { corners: 'square' } } });
      }
    });
  });

  it('finds a link and sets its organisation in the same transaction, or nothing at all', async () => {
    const db = t.app.get(Database);
    const unknown = await db.withTenantOf(
      'open_link_by_slug',
      'no-such-link',
      async (tx, found) => {
        const [r] = (await tx.execute(
          sql`select current_setting('app.tenant_id', true) as t`,
        )) as unknown as { t: string | null }[];
        return { found, tenant: r?.t ?? null };
      },
    );
    expect(unknown.found).toBeNull();
    expect(unknown.tenant || null).toBeNull();

    const q = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    const slug = `pq-${Date.now().toString(36)}`;
    await t.admin`insert into open_links (id, tenant_id, project_id, questionnaire_id, slug)
                  values (gen_random_uuid(), ${tenant.id}, ${project}, ${q}, ${slug})`;
    const seen = await db.withTenantOf('open_link_by_slug', slug, async (tx, found) => {
      // Row-level security applies with the organisation found: its projects are visible.
      const visible = await tx.select({ id: projects.id }).from(projects);
      return { found, visible: visible.map((p) => p.id) };
    });
    expect(seen.found?.tenantId).toBe(tenant.id);
    expect(seen.visible).toContain(project);
  });
});
