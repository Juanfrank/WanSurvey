import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { roleHasPermission, type Role } from '@wansurvey/schema';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../common/auth-context.js';
import { can } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import {
  assignments,
  caseEvents,
  cases,
  memberships,
  projects,
  sampleFields,
  tenantMembers,
  users,
} from '../db/schema.js';
import { compileRule } from './case-logic.js';

export interface Assignee {
  userId: string;
  name: string;
  email: string;
  roles: string[];
}

/** Batches of rows per INSERT, to stay well under Postgres' parameter limit. */
export const BATCH = 1000;

export function chunks<T>(xs: T[], n = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

@Injectable()
export class CasesService {
  async project(tx: Tx, projectId: string) {
    const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  async piiFields(tx: Tx, projectId: string): Promise<Set<string>> {
    const rows = await tx
      .select({ name: sampleFields.name })
      .from(sampleFields)
      .where(and(eq(sampleFields.projectId, projectId), eq(sampleFields.pii, true)));
    return new Set(rows.map((r) => r.name));
  }

  canSeePii(ctx: AuthContext, projectId: string) {
    return can(ctx.memberships, 'pii.view', projectId);
  }

  /** Only cases assigned to them, for people who may not read every case of the project. */
  restrictedToOwn(ctx: AuthContext, projectId: string) {
    return !can(ctx.memberships, 'cases.read_all', projectId);
  }

  /**
   * Active members who can work cases in this project: a role with `interviews.conduct` or
   * `dataentry.key`, tenant-wide or for this project.
   */
  async assignees(tx: Tx, projectId: string): Promise<Assignee[]> {
    const rows = await tx
      .select({
        userId: memberships.userId,
        role: memberships.role,
        name: users.name,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(
        tenantMembers,
        and(eq(tenantMembers.userId, memberships.userId), eq(tenantMembers.status, 'active')),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(or(isNull(memberships.projectId), eq(memberships.projectId, projectId)))
      .orderBy(asc(users.name));
    const byUser = new Map<string, Assignee>();
    for (const r of rows) {
      const role = r.role as Role;
      if (
        !roleHasPermission(role, 'interviews.conduct') &&
        !roleHasPermission(role, 'dataentry.key')
      )
        continue;
      const a = byUser.get(r.userId) ?? {
        userId: r.userId,
        name: r.name,
        email: r.email,
        roles: [],
      };
      a.roles.push(role);
      byUser.set(r.userId, a);
    }
    return [...byUser.values()];
  }

  async assertAssignee(tx: Tx, projectId: string, userId: string) {
    const ok = (await this.assignees(tx, projectId)).some((a) => a.userId === userId);
    if (!ok) {
      throw new BadRequestException({
        code: 'NOT_AN_ASSIGNEE',
        message:
          'Cases can only be assigned to active interviewers or data entry clerks of this project',
      });
    }
  }

  async events(
    tx: Tx,
    tenantId: string,
    actorUserId: string | null,
    rows: { caseId: string; type: string; details?: Record<string, unknown> }[],
  ) {
    for (const part of chunks(rows)) {
      if (!part.length) continue;
      await tx.insert(caseEvents).values(
        part.map((r) => ({
          tenantId,
          caseId: r.caseId,
          type: r.type,
          details: r.details ?? {},
          actorUserId,
        })),
      );
    }
  }

  /** Assigns (or unassigns, with null) cases; fresh ↔ assigned follows. Returns the count. */
  async assign(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    caseIds: string[],
    userId: string | null,
    via: string,
  ): Promise<number> {
    if (userId) await this.assertAssignee(tx, projectId, userId);
    let changed: { id: string; from: string | null }[] = [];
    for (const part of chunks(caseIds)) {
      const before = await tx
        .select({ id: cases.id, from: cases.assignedTo })
        .from(cases)
        .where(and(eq(cases.projectId, projectId), inArray(cases.id, part)));
      const ids = before.filter((b) => b.from !== userId).map((b) => b.id);
      if (!ids.length) continue;
      await tx
        .update(cases)
        .set({
          assignedTo: userId,
          status: userId
            ? sql`case when ${cases.status} = 'fresh' then 'assigned' else ${cases.status} end`
            : sql`case when ${cases.status} = 'assigned' then 'fresh' else ${cases.status} end`,
          updatedAt: new Date(),
        })
        .where(inArray(cases.id, ids));
      changed = changed.concat(before.filter((b) => ids.includes(b.id)));
    }
    await this.events(
      tx,
      ctx.tenantId,
      ctx.userId,
      changed.map((c) => ({
        caseId: c.id,
        type: userId ? 'assigned' : 'unassigned',
        details: { from: c.from, to: userId, via },
      })),
    );
    return changed.length;
  }

  /**
   * Applies the project's active rules, oldest first, to unassigned fresh cases (optionally
   * only `onlyCaseIds`, or only one rule). Quotas cap the cases a rule's person holds in total.
   */
  async applyRules(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    opts: { onlyCaseIds?: string[]; ruleId?: string } = {},
  ): Promise<number> {
    const rules = await tx
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.projectId, projectId),
          eq(assignments.active, true),
          ...(opts.ruleId ? [eq(assignments.id, opts.ruleId)] : []),
        ),
      )
      .orderBy(asc(assignments.createdAt));
    if (!rules.length) return 0;
    const pool = await tx
      .select({
        id: cases.id,
        sample: cases.sample,
        status: cases.status,
        priority: cases.priority,
        modePreference: cases.modePreference,
      })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          isNull(cases.assignedTo),
          eq(cases.status, 'fresh'),
          ...(opts.onlyCaseIds ? [inArray(cases.id, opts.onlyCaseIds)] : []),
        ),
      )
      .orderBy(sql`${cases.priority} desc`, asc(cases.id));
    const taken = new Set<string>();
    let total = 0;
    const eligible = new Set((await this.assignees(tx, projectId)).map((a) => a.userId));
    for (const rule of rules) {
      if (!eligible.has(rule.userId)) continue;
      const match = compileRule(rule.filter);
      let room = Infinity;
      if (rule.quota !== null) {
        const [held] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(cases)
          .where(and(eq(cases.projectId, projectId), eq(cases.assignedTo, rule.userId)));
        room = Math.max(0, rule.quota - (held?.n ?? 0));
      }
      const ids: string[] = [];
      for (const c of pool) {
        if (ids.length >= room) break;
        if (!taken.has(c.id) && match(c)) ids.push(c.id);
      }
      ids.forEach((id) => taken.add(id));
      if (ids.length)
        total += await this.assign(tx, ctx, projectId, ids, rule.userId, `rule:${rule.id}`);
    }
    return total;
  }
}
