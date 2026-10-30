import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import { teamMembers, teams, tenantMembers, users } from '../db/schema.js';
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

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

class PgTeamsTx implements TeamsTx {
  constructor(
    private readonly tx: Tx,
    private readonly tenantId: string,
    private readonly audits: AuditService,
  ) {}

  async list() {
    const rows = await this.tx.select().from(teams).orderBy(asc(teams.name));
    const members = rows.length
      ? await this.tx
          .select({
            teamId: teamMembers.teamId,
            userId: users.id,
            name: users.name,
            email: users.email,
          })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(
            inArray(
              teamMembers.teamId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(users.name))
      : [];
    return rows.map((r) => {
      const ms = members.filter((m) => m.teamId === r.id);
      const leader = r.leaderUserId ? (ms.find((m) => m.userId === r.leaderUserId) ?? null) : null;
      return {
        id: r.id,
        name: r.name,
        leaderId: r.leaderUserId,
        leaderName: leader?.name ?? null,
        members: ms.map(({ teamId: _t, ...m }) => m),
      };
    });
  }

  async strangers(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = await this.tx
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(inArray(tenantMembers.userId, unique));
    const known = new Set(found.map((f) => f.userId));
    return unique.filter((i) => !known.has(i));
  }

  async nameTaken(name: string, except?: string) {
    const [dup] = await this.tx.select({ id: teams.id }).from(teams).where(eq(teams.name, name));
    return !!dup && dup.id !== except;
  }

  private async setMembers(teamId: string, ids: string[]) {
    await this.tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
    const unique = [...new Set(ids)];
    if (unique.length)
      await this.tx
        .insert(teamMembers)
        .values(unique.map((userId) => ({ teamId, userId, tenantId: this.tenantId })));
  }

  async create(v: { name: string; leaderId: string | null; memberIds: string[] }) {
    const [team] = await this.tx
      .insert(teams)
      .values({ tenantId: this.tenantId, name: v.name, leaderUserId: v.leaderId })
      .returning();
    await this.setMembers(team!.id, v.memberIds);
    return team!.id;
  }

  async current(id: string) {
    const [team] = await this.tx.select().from(teams).where(eq(teams.id, id));
    if (!team) return null;
    const ms = await this.tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, id));
    return { leaderId: team.leaderUserId, memberIds: ms.map((m) => m.userId) };
  }

  async update(id: string, v: { name?: string; leaderId: string | null; memberIds?: string[] }) {
    if (v.memberIds) await this.setMembers(id, v.memberIds);
    await this.tx
      .update(teams)
      .set({ ...(v.name ? { name: v.name } : {}), leaderUserId: v.leaderId })
      .where(eq(teams.id, id));
  }

  async remove(id: string) {
    const r = await this.tx.delete(teams).where(eq(teams.id, id)).returning({ name: teams.name });
    return r[0]?.name ?? null;
  }

  audit(entry: AuditEntry) {
    return this.audits.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class PgTeamsRepo implements TeamsRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: TeamsTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) => fn(new PgTeamsTx(tx, tenantId, this.audits)));
  }
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
