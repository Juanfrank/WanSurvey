import { randomUUID } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { MssqlTx } from '../db/mssql/database.js';
import type { MssqlSchema } from '../db/mssql/schema.js';

/**
 * Organisations and projects on SQL Server (Kysely), for `tenants.controller.ts` and
 * `projects.controller.ts`. Takes the transaction of `MssqlDatabase.withTenant`.
 */
export type TenantRow = Omit<
  Selectable<MssqlSchema['tenants']>,
  'settings' | 'branding' | 'role_permissions'
> & {
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
  role_permissions: Record<string, unknown>;
};

export type ProjectRow = Omit<
  Selectable<MssqlSchema['projects']>,
  'modes_enabled' | 'languages' | 'settings'
> & { modes_enabled: string[]; languages: string[]; settings: Record<string, unknown> };

const toProject = (r: Selectable<MssqlSchema['projects']>): ProjectRow => ({
  ...r,
  modes_enabled: JSON.parse(r.modes_enabled) as string[],
  languages: JSON.parse(r.languages) as string[],
  settings: JSON.parse(r.settings) as Record<string, unknown>,
});

export class ProjectsStore {
  // ─── The organisation in context ──────────────────────────────────────────────────

  async tenant(tx: MssqlTx, id: string): Promise<TenantRow | null> {
    const t = await tx.selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
    return t
      ? {
          ...t,
          settings: JSON.parse(t.settings) as Record<string, unknown>,
          branding: JSON.parse(t.branding) as Record<string, unknown>,
          role_permissions: JSON.parse(t.role_permissions) as Record<string, unknown>,
        }
      : null;
  }

  /** Changes name, plan or branding, and merges `settings` into the ones there are. */
  async updateTenant(
    tx: MssqlTx,
    id: string,
    v: { name?: string; branding?: Record<string, unknown>; settings?: Record<string, unknown> },
  ): Promise<TenantRow | null> {
    const current = await this.tenant(tx, id);
    if (!current) return null;
    await tx
      .updateTable('tenants')
      .set({
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.branding !== undefined ? { branding: JSON.stringify(v.branding) } : {}),
        ...(v.settings ? { settings: JSON.stringify({ ...current.settings, ...v.settings }) } : {}),
      })
      .where('id', '=', id)
      .execute();
    return this.tenant(tx, id);
  }

  /** Replaces the organisation's changes to what each role may do. */
  async setRolePermissions(
    tx: MssqlTx,
    id: string,
    kept: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const before = (await this.tenant(tx, id))?.role_permissions ?? {};
    await tx
      .updateTable('tenants')
      .set({ role_permissions: JSON.stringify(kept) })
      .where('id', '=', id)
      .execute();
    return before;
  }

  // ─── Projects ─────────────────────────────────────────────────────────────────────

  /** Every project by name, or only the ones given. */
  async list(tx: MssqlTx, only?: string[]): Promise<ProjectRow[]> {
    if (only && !only.length) return [];
    let q = tx.selectFrom('projects').selectAll();
    if (only) q = q.where('id', 'in', only);
    return (await q.orderBy('name').execute()).map(toProject);
  }

  async get(tx: MssqlTx, id: string): Promise<ProjectRow | null> {
    const p = await tx.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
    return p ? toProject(p) : null;
  }

  async codeTaken(tx: MssqlTx, code: string): Promise<boolean> {
    return !!(await tx
      .selectFrom('projects')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirst());
  }

  async create(
    tx: MssqlTx,
    v: {
      tenantId: string;
      name: string;
      code: string;
      status?: string;
      modesEnabled?: string[];
      timezone?: string;
      languages?: string[];
      settings?: Record<string, unknown>;
    },
  ): Promise<ProjectRow> {
    const id = randomUUID();
    await tx
      .insertInto('projects')
      .values({
        id,
        tenant_id: v.tenantId,
        name: v.name,
        code: v.code,
        ...(v.status ? { status: v.status } : {}),
        modes_enabled: JSON.stringify(v.modesEnabled ?? []),
        ...(v.timezone ? { timezone: v.timezone } : {}),
        languages: JSON.stringify(v.languages ?? ['es']),
        settings: JSON.stringify(v.settings ?? {}),
      })
      .execute();
    return (await this.get(tx, id))!;
  }

  /** Changes fields; `settings` merges into the current ones. */
  async update(
    tx: MssqlTx,
    id: string,
    v: {
      name?: string;
      code?: string;
      status?: string;
      modesEnabled?: string[];
      timezone?: string;
      languages?: string[];
      settings?: Record<string, unknown>;
    },
  ): Promise<ProjectRow | null> {
    const current = await this.get(tx, id);
    if (!current) return null;
    await tx
      .updateTable('projects')
      .set({
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.code !== undefined ? { code: v.code } : {}),
        ...(v.status !== undefined ? { status: v.status } : {}),
        ...(v.modesEnabled !== undefined ? { modes_enabled: JSON.stringify(v.modesEnabled) } : {}),
        ...(v.timezone !== undefined ? { timezone: v.timezone } : {}),
        ...(v.languages !== undefined ? { languages: JSON.stringify(v.languages) } : {}),
        ...(v.settings ? { settings: JSON.stringify({ ...current.settings, ...v.settings }) } : {}),
      })
      .where('id', '=', id)
      .execute();
    return this.get(tx, id);
  }

  // ─── Logo ─────────────────────────────────────────────────────────────────────────

  /** Sets the logo, replacing any other; returns when it changed. */
  async setLogo(
    tx: MssqlTx,
    v: { projectId: string; tenantId: string; contentType: string; image: Buffer },
  ): Promise<Date> {
    const at = new Date();
    await tx.deleteFrom('project_logos').where('project_id', '=', v.projectId).execute();
    await tx
      .insertInto('project_logos')
      .values({
        project_id: v.projectId,
        tenant_id: v.tenantId,
        content_type: v.contentType,
        image: v.image,
        updated_at: at,
      })
      .execute();
    await tx
      .updateTable('projects')
      .set({ logo_updated_at: at })
      .where('id', '=', v.projectId)
      .execute();
    return at;
  }

  async logo(
    tx: MssqlTx,
    projectId: string,
  ): Promise<{ contentType: string; image: Buffer; updatedAt: Date } | null> {
    const l = await tx
      .selectFrom('project_logos')
      .select(['content_type', 'image', 'updated_at'])
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return l ? { contentType: l.content_type, image: l.image, updatedAt: l.updated_at } : null;
  }

  async removeLogo(tx: MssqlTx, projectId: string): Promise<void> {
    await tx.deleteFrom('project_logos').where('project_id', '=', projectId).execute();
    await tx
      .updateTable('projects')
      .set({ logo_updated_at: null })
      .where('id', '=', projectId)
      .execute();
  }
}
