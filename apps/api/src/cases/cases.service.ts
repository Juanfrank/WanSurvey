import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  projectSettings,
  roleHasPermission,
  type ProjectSettings,
  type Role,
} from '@wansurvey/schema';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { can } from '../common/auth-context.js';
import type { Tx } from '../db/database.js';
import {
  assignments,
  auditLog,
  caseEvents,
  cases,
  contacts,
  memberships,
  projects,
  sampleFields,
  tenantMembers,
  users,
} from '../db/schema.js';
import { STRATEGIES } from './strategies.js';

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
  constructor(private readonly audit: AuditService) {}

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

  /** The project's settings, with defaults. */
  async settings(tx: Tx, projectId: string): Promise<ProjectSettings> {
    return projectSettings((await this.project(tx, projectId)).settings);
  }

  /**
   * Interviewers see the personal data of the cases they hold without asking, when the project
   * allows it and they hold `pii.view`. Supervisors and managers still reveal per case.
   */
  autoReveal(ctx: AuthContext, projectId: string, settings: ProjectSettings) {
    return (
      settings.revealToInterviewers &&
      this.restrictedToOwn(ctx, projectId) &&
      this.canSeePii(ctx, projectId)
    );
  }

  /**
   * Records `case.pii_viewed` for the cases this person has not been shown before. Automatic
   * views are recorded once per person and case; explicit reveals are recorded every time.
   */
  async recordAutoViews(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    shown: { id: string; externalId: string }[],
    via: 'detail' | 'list',
  ) {
    if (!shown.length) return;
    const seen = new Set(
      (
        await tx
          .select({ id: auditLog.targetId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'case.pii_viewed'),
              eq(auditLog.actorUserId, ctx.userId),
              inArray(
                auditLog.targetId,
                shown.map((c) => c.id),
              ),
            ),
          )
      ).map((r) => r.id),
    );
    for (const c of shown) {
      if (seen.has(c.id)) continue;
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'case.pii_viewed',
          targetType: 'case',
          targetId: c.id,
          details: { projectId, externalId: c.externalId, auto: true, via },
        }),
      );
    }
  }

  /**
   * Other projects of the organisation with a case sharing one of these phones or e-mails, and
   * how many such cases each has, keyed by the row that has them (`key`, e.g. a row number).
   * Only names and counts come back, never the matching values.
   */
  async matchesElsewhere(
    tx: Tx,
    projectId: string,
    items: { key: string; type: string; value: string }[],
  ): Promise<Map<string, { projectId: string; name: string; cases: number }[]>> {
    const out = new Map<
      string,
      Map<string, { projectId: string; name: string; cases: Set<string> }>
    >();
    const byValue = new Map<string, string[]>();
    for (const i of items) {
      const k = `${i.type}\u0000${i.value}`;
      byValue.set(k, [...(byValue.get(k) ?? []), i.key]);
    }
    const pairs = [...byValue.keys()].map((k) => k.split('\u0000') as [string, string]);
    for (const part of chunks(pairs, 500)) {
      const rows = await tx
        .select({
          type: contacts.type,
          value: contacts.value,
          caseId: cases.id,
          projectId: projects.id,
          name: projects.name,
        })
        .from(contacts)
        .innerJoin(cases, eq(cases.id, contacts.caseId))
        .innerJoin(projects, eq(projects.id, cases.projectId))
        .where(
          and(
            ne(cases.projectId, projectId),
            or(
              ...part.map(([type, value]) =>
                and(eq(contacts.type, type), eq(contacts.value, value)),
              ),
            ),
          ),
        );
      for (const r of rows)
        for (const key of byValue.get(`${r.type}\u0000${r.value}`) ?? []) {
          const per = out.get(key) ?? new Map();
          const p = per.get(r.projectId) ?? {
            projectId: r.projectId,
            name: r.name,
            cases: new Set(),
          };
          p.cases.add(r.caseId);
          per.set(r.projectId, p);
          out.set(key, per);
        }
    }
    return new Map(
      [...out].map(([key, per]) => [
        key,
        [...per.values()]
          .map((p) => ({ projectId: p.projectId, name: p.name, cases: p.cases.size }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ]),
    );
  }

  /** `matchesElsewhere` for one case's contacts. */
  async elsewhere(tx: Tx, projectId: string, cs: { type: string; value: string }[]) {
    if (!cs.length) return [];
    const found = await this.matchesElsewhere(
      tx,
      projectId,
      cs.map((c) => ({ key: 'case', ...c })),
    );
    return found.get('case') ?? [];
  }

  /**
   * Hands out unassigned fresh cases (optionally only `onlyCaseIds`, or only one rule) with the
   * project's active assignments, each kind by its strategy. Returns the number assigned.
   */
  async applyRules(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    opts: { onlyCaseIds?: string[]; ruleId?: string } = {},
  ): Promise<number> {
    const eligible = new Set((await this.assignees(tx, projectId)).map((a) => a.userId));
    const rules = (
      await tx
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.projectId, projectId),
            eq(assignments.active, true),
            ...(opts.ruleId ? [eq(assignments.id, opts.ruleId)] : []),
          ),
        )
        .orderBy(asc(assignments.createdAt))
    ).filter((r) => eligible.has(r.userId));
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
    const load = await tx
      .select({ userId: cases.assignedTo, n: sql<number>`count(*)::int` })
      .from(cases)
      .where(eq(cases.projectId, projectId))
      .groupBy(cases.assignedTo);
    const held = new Map(load.filter((l) => l.userId).map((l) => [l.userId!, l.n]));
    const taken = new Set<string>();
    let total = 0;
    for (const strategy of STRATEGIES) {
      const mine = rules.filter((r) => r.kind === strategy.kind);
      if (!mine.length) continue;
      for (const hand of strategy.plan({ rules: mine, pool, held, taken }))
        total += await this.assign(
          tx,
          ctx,
          projectId,
          hand.caseIds,
          hand.userId,
          `rule:${hand.ruleId}`,
        );
    }
    return total;
  }

  /**
   * Pool mode: the caller takes an unassigned fresh case. The conditional update makes two
   * simultaneous claims safe: only one finds the case still free.
   */
  async claim(tx: Tx, ctx: AuthContext, projectId: string, caseId: string) {
    const settings = await this.settings(tx, projectId);
    if (settings.assignmentMode !== 'pool')
      throw new BadRequestException({
        code: 'NOT_POOL',
        message: 'Cases of this project are assigned by a supervisor',
      });
    await this.assertAssignee(tx, projectId, ctx.userId);
    const [row] = await tx
      .update(cases)
      .set({ assignedTo: ctx.userId, status: 'assigned', updatedAt: new Date() })
      .where(
        and(
          eq(cases.id, caseId),
          eq(cases.projectId, projectId),
          isNull(cases.assignedTo),
          eq(cases.status, 'fresh'),
        ),
      )
      .returning({ id: cases.id, externalId: cases.externalId });
    if (!row) {
      const [exists] = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)));
      if (!exists) throw new NotFoundException('Case not found');
      throw new ConflictException({
        code: 'ALREADY_TAKEN',
        message: 'Someone else has taken this case',
      });
    }
    await this.events(tx, ctx.tenantId, ctx.userId, [
      { caseId, type: 'claimed', details: { to: ctx.userId } },
    ]);
    return row;
  }

  /** Returns a case to the unassigned cases. Its holder, or someone with `cases.assign`. */
  async release(tx: Tx, ctx: AuthContext, projectId: string, caseId: string) {
    const [c] = await tx
      .select({ id: cases.id, assignedTo: cases.assignedTo, status: cases.status })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)));
    const manager = can(ctx.memberships, 'cases.assign', projectId);
    if (!c || (!manager && c.assignedTo !== ctx.userId))
      throw new NotFoundException('Case not found');
    if (!c.assignedTo) return { released: false };
    if (c.status !== 'assigned')
      throw new BadRequestException({
        code: 'NOT_RELEASABLE',
        message: 'Only cases not yet started can be released',
      });
    await tx
      .update(cases)
      .set({ assignedTo: null, status: 'fresh', updatedAt: new Date() })
      .where(eq(cases.id, caseId));
    await this.events(tx, ctx.tenantId, ctx.userId, [
      { caseId, type: 'released', details: { from: c.assignedTo } },
    ]);
    return { released: true };
  }
}
