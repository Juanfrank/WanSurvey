import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { ProjectsStore, type ProjectRow, type TenantRow } from './projects-store.mssql.js';

/**
 * What the organisation and project controllers need from the database, whichever engine runs
 * (the pattern of `auth/auth-repo.ts`): the PostgreSQL side is the Drizzle code they had, the SQL
 * Server side uses `ProjectsStore`. Rows come out in one shape, as Drizzle returned them.
 */
export interface TenantView {
  id: string;
  name: string;
  slug: string;
  plan: string;
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
  rolePermissions: Record<string, unknown>;
  createdAt: Date;
}

export interface ProjectView {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  status: string;
  modesEnabled: string[];
  timezone: string;
  languages: string[];
  settings: unknown;
  logoUpdatedAt: Date | null;
  createdAt: Date;
}

export interface NewProject {
  name: string;
  code: string;
  modesEnabled: string[];
  timezone: string;
  languages: string[];
}

export interface ProjectChanges {
  name?: string;
  code?: string;
  status?: string;
  modesEnabled?: string[];
  timezone?: string;
  languages?: string[];
  /** Merged into the stored settings; keys left out keep their value. */
  settings?: Record<string, unknown>;
}

export interface OrgTx {
  tenant(): Promise<TenantView | null>;
  /** Changes name or branding, and merges `settings` into the ones there are. */
  updateTenant(v: {
    name?: string;
    branding?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  }): Promise<TenantView | null>;
  /** Replaces the organisation's changes to what each role may do; returns what was there. */
  setRolePermissions(kept: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Every project by name, or only the ones given. */
  projects(only?: string[]): Promise<ProjectView[]>;
  project(id: string): Promise<ProjectView | null>;
  codeTaken(code: string): Promise<boolean>;
  createProject(v: NewProject): Promise<ProjectView>;
  updateProject(id: string, v: ProjectChanges): Promise<ProjectView | null>;
  setLogo(id: string, v: { contentType: string; image: Buffer }): Promise<ProjectView | null>;
  logo(id: string): Promise<{ contentType: string; image: Buffer } | null>;
  removeLogo(id: string): Promise<ProjectView | null>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface OrgRepo {
  inTenant<T>(tenantId: string, fn: (t: OrgTx) => Promise<T>): Promise<T>;
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

const toTenant = (t: TenantRow): TenantView => ({
  id: t.id.toLowerCase(),
  name: t.name,
  slug: t.slug,
  plan: t.plan,
  settings: t.settings,
  branding: t.branding,
  rolePermissions: t.role_permissions,
  createdAt: t.created_at,
});

const toProject = (p: ProjectRow): ProjectView => ({
  id: p.id.toLowerCase(),
  tenantId: p.tenant_id.toLowerCase(),
  name: p.name,
  code: p.code,
  status: p.status,
  modesEnabled: p.modes_enabled,
  timezone: p.timezone,
  languages: p.languages,
  settings: p.settings,
  logoUpdatedAt: p.logo_updated_at,
  createdAt: p.created_at,
});

class MssqlOrgTx implements OrgTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly projectsStore: ProjectsStore,
    private readonly auditStore: AuditStore,
  ) {}

  async tenant() {
    const t = await this.projectsStore.tenant(this.tx, this.tenantId);
    return t && toTenant(t);
  }

  async updateTenant(v: {
    name?: string;
    branding?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  }) {
    const t = await this.projectsStore.updateTenant(this.tx, this.tenantId, v);
    return t && toTenant(t);
  }

  setRolePermissions(kept: Record<string, unknown>) {
    return this.projectsStore.setRolePermissions(this.tx, this.tenantId, kept);
  }

  async projects(only?: string[]) {
    return (await this.projectsStore.list(this.tx, only)).map(toProject);
  }

  async project(id: string) {
    const p = await this.projectsStore.get(this.tx, id);
    return p && toProject(p);
  }

  codeTaken(code: string) {
    return this.projectsStore.codeTaken(this.tx, code);
  }

  async createProject(v: NewProject) {
    return toProject(await this.projectsStore.create(this.tx, { tenantId: this.tenantId, ...v }));
  }

  async updateProject(id: string, v: ProjectChanges) {
    const p = await this.projectsStore.update(this.tx, id, v);
    return p && toProject(p);
  }

  async setLogo(id: string, v: { contentType: string; image: Buffer }) {
    if (!(await this.project(id))) return null;
    await this.projectsStore.setLogo(this.tx, { projectId: id, tenantId: this.tenantId, ...v });
    return this.project(id);
  }

  async logo(id: string) {
    const l = await this.projectsStore.logo(this.tx, id);
    return l && { contentType: l.contentType, image: l.image };
  }

  async removeLogo(id: string) {
    if (!(await this.project(id))) return null;
    await this.projectsStore.removeLogo(this.tx, id);
    return this.project(id);
  }

  audit(entry: AuditEntry) {
    return this.auditStore.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class MssqlOrgRepo implements OrgRepo {
  private readonly projectsStore = new ProjectsStore();
  private readonly auditStore = new AuditStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: OrgTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlOrgTx(tx, tenantId, this.projectsStore, this.auditStore)),
    );
  }
}

export const ORG_REPO = Symbol('ORG_REPO');
