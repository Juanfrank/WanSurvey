import { randomUUID } from 'node:crypto';
import type { MssqlTx } from '../db/mssql/database.js';

/**
 * Teams of the organisation on SQL Server (Kysely): what `teams.controller.ts` does on PostgreSQL
 * with Drizzle, as a store for the switch (docs/roadmap.md). A name, a leader and members, all
 * people of the organisation; the leader is also a member.
 */
export interface Team {
  id: string;
  name: string;
  leaderId: string | null;
  leaderName: string | null;
  members: { userId: string; name: string; email: string }[];
}

const lower = (s: string | null) => (s === null ? null : s.toLowerCase());

export class TeamsStore {
  async list(tx: MssqlTx): Promise<Team[]> {
    const teams = await tx.selectFrom('teams').selectAll().orderBy('name').execute();
    if (!teams.length) return [];
    const members = await tx
      .selectFrom('team_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.team_id', 'u.id as user_id', 'u.name', 'u.email'])
      .orderBy('u.name')
      .execute();
    return teams.map((t) => {
      const ms = members
        .filter((m) => m.team_id === t.id)
        .map((m) => ({ userId: m.user_id.toLowerCase(), name: m.name, email: m.email }));
      const leaderId = lower(t.leader_user_id);
      return {
        id: t.id.toLowerCase(),
        name: t.name,
        leaderId,
        leaderName: ms.find((m) => m.userId === leaderId)?.name ?? null,
        members: ms,
      };
    });
  }

  /** The ids that are not people of the organisation (it has a membership for them). */
  async strangers(tx: MssqlTx, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
    if (!unique.length) return [];
    const found = await tx
      .selectFrom('memberships')
      .select('user_id')
      .where('user_id', 'in', unique)
      .execute();
    const known = new Set(found.map((f) => f.user_id.toLowerCase()));
    return unique.filter((i) => !known.has(i));
  }

  async nameTaken(tx: MssqlTx, name: string, except?: string): Promise<boolean> {
    const dup = await tx
      .selectFrom('teams')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    return !!dup && dup.id.toLowerCase() !== except?.toLowerCase();
  }

  async setMembers(tx: MssqlTx, tenantId: string, teamId: string, ids: string[]): Promise<void> {
    await tx.deleteFrom('team_members').where('team_id', '=', teamId).execute();
    const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
    if (unique.length)
      await tx
        .insertInto('team_members')
        .values(unique.map((user_id) => ({ team_id: teamId, user_id, tenant_id: tenantId })))
        .execute();
  }

  async memberIds(tx: MssqlTx, teamId: string): Promise<string[]> {
    return (
      await tx.selectFrom('team_members').select('user_id').where('team_id', '=', teamId).execute()
    ).map((m) => m.user_id.toLowerCase());
  }

  async get(tx: MssqlTx, id: string) {
    return tx.selectFrom('teams').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Creates a team with its members (the leader added to them). Returns its id. */
  async create(
    tx: MssqlTx,
    v: { tenantId: string; name: string; leaderId: string | null; memberIds: string[] },
  ): Promise<string> {
    const id = randomUUID();
    await tx
      .insertInto('teams')
      .values({ id, tenant_id: v.tenantId, name: v.name, leader_user_id: v.leaderId })
      .execute();
    await this.setMembers(tx, v.tenantId, id, [
      ...v.memberIds,
      ...(v.leaderId ? [v.leaderId] : []),
    ]);
    return id;
  }

  async update(
    tx: MssqlTx,
    tenantId: string,
    id: string,
    v: { name?: string; leaderId?: string | null; memberIds?: string[] },
  ): Promise<boolean> {
    const team = await this.get(tx, id);
    if (!team) return false;
    const leaderId = v.leaderId !== undefined ? v.leaderId : team.leader_user_id;
    if (v.memberIds || v.leaderId)
      await this.setMembers(tx, tenantId, id, [
        ...(v.memberIds ?? (await this.memberIds(tx, id))),
        ...(leaderId ? [leaderId] : []),
      ]);
    await tx
      .updateTable('teams')
      .set({ ...(v.name ? { name: v.name } : {}), leader_user_id: leaderId })
      .where('id', '=', id)
      .execute();
    return true;
  }

  /** Deletes a team (its members go with it); returns its name, or null when there is none. */
  async remove(tx: MssqlTx, id: string): Promise<string | null> {
    const team = await this.get(tx, id);
    if (!team) return null;
    await tx.deleteFrom('teams').where('id', '=', id).execute();
    return team.name;
  }
}
