import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
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

/** What is still open in a project (see `ProjectsStore.closeout`). */
export interface Closeout {
  /** Cases not yet finalised or withdrawn. */
  openCases: number;
  /** Interviews started and not submitted, or returned to be fixed. */
  openInterviews: number;
  /** Submitted interviews nobody has approved, returned or rejected yet. */
  pendingReview: number;
  exportsDone: number;
  lastExportAt: Date | null;
  /** Client links not revoked nor expired. */
  activeShareLinks: number;
  /** People with a role in this project only (organisation-wide roles are not counted). */
  projectMembers: number;
}

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

  /**
   * Changes name, branding or regional format, and merges `settings` into the ones there are.
   */
  async updateTenant(
    tx: MssqlTx,
    id: string,
    v: {
      name?: string;
      branding?: Record<string, unknown>;
      settings?: Record<string, unknown>;
      formatLocale?: string | null;
    },
  ): Promise<TenantRow | null> {
    const current = await this.tenant(tx, id);
    if (!current) return null;
    await tx
      .updateTable('tenants')
      .set({
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.branding !== undefined ? { branding: JSON.stringify(v.branding) } : {}),
        ...(v.settings ? { settings: JSON.stringify({ ...current.settings, ...v.settings }) } : {}),
        ...(v.formatLocale !== undefined ? { format_locale: v.formatLocale } : {}),
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

  /** What is still open in a project, for the checklist before closing or archiving it. */
  async closeout(tx: MssqlTx, projectId: string): Promise<Closeout> {
    const r = await sql<Closeout & { lastExportAt: Date | null }>`
      SELECT
        (SELECT COUNT(*) FROM cases WHERE project_id = ${projectId}
          AND status IN ('fresh', 'assigned', 'in_progress')) AS openCases,
        (SELECT COUNT(*) FROM interviews WHERE project_id = ${projectId}
          AND status IN ('in_progress', 'returned')) AS openInterviews,
        (SELECT COUNT(*) FROM interviews WHERE project_id = ${projectId}
          AND status IN ('submitted', 'in_review', 'resubmitted')) AS pendingReview,
        (SELECT COUNT(*) FROM exports WHERE project_id = ${projectId}
          AND status = 'done') AS exportsDone,
        (SELECT MAX(finished_at) FROM exports WHERE project_id = ${projectId}
          AND status = 'done') AS lastExportAt,
        (SELECT COUNT(*) FROM share_links WHERE project_id = ${projectId} AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > SYSDATETIMEOFFSET())) AS activeShareLinks,
        (SELECT COUNT(DISTINCT user_id) FROM memberships
          WHERE project_id = ${projectId}) AS projectMembers`.execute(tx);
    const row = r.rows[0]!;
    return { ...row, lastExportAt: row.lastExportAt ? new Date(row.lastExportAt) : null };
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
