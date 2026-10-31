import { Injectable } from '@nestjs/common';
import type { AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { TeamsStore, type Team } from './teams-store.mssql.js';

/**
 * What the teams controller needs from the database, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`): the PostgreSQL side is the Drizzle code the controller had, the SQL Server
 * side uses `TeamsStore`. The rules (people of the organisation, unique name, leader is a member)
 * live once, in the controller.
 */
export type { Team };

export interface TeamsTx {
  list(): Promise<Team[]>;
  /** The ids that are not people of the organisation. */
  strangers(ids: string[]): Promise<string[]>;
  nameTaken(name: string, except?: string): Promise<boolean>;
  /** Creates the team with these members (the leader already among them); returns its id. */
  create(v: { name: string; leaderId: string | null; memberIds: string[] }): Promise<string>;
  /** The team's current leader and members, or null when there is none. */
  current(id: string): Promise<{ leaderId: string | null; memberIds: string[] } | null>;
  /** Applies the changes; `memberIds` (leader included) replaces the members when given. */
  update(
    id: string,
    v: { name?: string; leaderId: string | null; memberIds?: string[] },
  ): Promise<void>;
  /** Deletes a team; returns its name, or null when there is none. */
  remove(id: string): Promise<string | null>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface TeamsRepo {
  inTenant<T>(tenantId: string, fn: (t: TeamsTx) => Promise<T>): Promise<T>;
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

class MssqlTeamsTx implements TeamsTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly store: TeamsStore,
    private readonly auditStore: AuditStore,
  ) {}

  list() {
    return this.store.list(this.tx);
  }

  strangers(ids: string[]) {
    return this.store.strangers(this.tx, ids);
  }

  nameTaken(name: string, except?: string) {
    return this.store.nameTaken(this.tx, name, except);
  }

  create(v: { name: string; leaderId: string | null; memberIds: string[] }) {
    return this.store.create(this.tx, { tenantId: this.tenantId, ...v });
  }

  async current(id: string) {
    const team = await this.store.get(this.tx, id);
    if (!team) return null;
    return {
      leaderId: team.leader_user_id?.toLowerCase() ?? null,
      memberIds: await this.store.memberIds(this.tx, id),
    };
  }

  async update(id: string, v: { name?: string; leaderId: string | null; memberIds?: string[] }) {
    if (v.memberIds) await this.store.setMembers(this.tx, this.tenantId, id, v.memberIds);
    await this.store.update(this.tx, this.tenantId, id, { name: v.name, leaderId: v.leaderId });
  }

  remove(id: string) {
    return this.store.remove(this.tx, id);
  }

  audit(entry: AuditEntry) {
    return this.auditStore.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class MssqlTeamsRepo implements TeamsRepo {
  private readonly store = new TeamsStore();
  private readonly auditStore = new AuditStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: TeamsTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlTeamsTx(tx, tenantId, this.store, this.auditStore)),
    );
  }
}

export const TEAMS_REPO = Symbol('TEAMS_REPO');
