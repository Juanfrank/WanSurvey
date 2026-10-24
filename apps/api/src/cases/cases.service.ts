import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  projectSettings,
  roleHasPermission,
  roleMatrix,
  type ProjectSettings,
  type Role,
} from '@wansurvey/schema';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { can } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import type { Tx } from '../db/database.js';
import {
  assignments,
  auditLog,
  caseEvents,
  cases,
  contacts,
  memberships,
  projects,
  questionnaires,
  sampleFields,
  tenantMembers,
  tenants,
  users,
} from '../db/schema.js';
import { maskSample } from './case-logic.js';
import { PiiCipher } from './pii.js';
import { rememberedProject } from './project-memo.js';
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

/**
 * The cases of one questionnaire: its own, and those that belong to none (written before
 * cases were per questionnaire). No questionnaire: every case of the project.
 */
export function ofQuestionnaire(questionnaireId?: string | null) {
  return questionnaireId
    ? or(eq(cases.questionnaireId, questionnaireId), isNull(cases.questionnaireId))!
    : undefined;
}

@Injectable()
export class CasesService {
  /** Seals and opens personal sample fields (H1). */
  readonly pii: PiiCipher;

  constructor(
    private readonly audit: AuditService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.pii = new PiiCipher(config.APP_ENCRYPTION_KEY);
  }

  /** Rows with the whole sample: plain fields and the sealed personal ones (H1). */
  openRows<T extends { sample: unknown; samplePii: string | null }>(rows: T[]) {
    return rows.map(({ samplePii, ...r }) => ({
      ...r,
      sample: this.pii.read({ sample: r.sample, samplePii }),
    }));
  }

  selectCases(tx: Tx) {
    return tx
      .select({
        id: cases.id,
        externalId: cases.externalId,
        sample: cases.sample,
        samplePii: cases.samplePii,
        questionnaireId: cases.questionnaireId,
        status: cases.status,
        disposition: cases.disposition,
        attempts: cases.attempts,
        assignedAt: cases.assignedAt,
        priority: cases.priority,
        modePreference: cases.modePreference,
        assignedTo: cases.assignedTo,
        assignedName: users.name,
        checkedOutAt: cases.checkedOutAt,
        anonymisedAt: cases.anonymisedAt,
        updatedAt: cases.updatedAt,
        selectionRole: cases.selectionRole,
        substituteFor: cases.substituteFor,
        inclusionProb: cases.inclusionProb,
        baseWeight: cases.baseWeight,
      })
      .from(cases)
      .leftJoin(users, eq(users.id, cases.assignedTo))
      .$dynamic();
  }

  async project(tx: Tx, projectId: string) {
    const known = rememberedProject(tx, projectId);
    if (known) return known;
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

  /**
   * Cases as a person's rule filter sees them: without `pii.view`, personal fields masked,
   * as they are listed, so a filter cannot tell what a hidden value is.
   */
  forRules<T extends { sample: unknown }>(
    ctx: AuthContext,
    projectId: string,
    pii: ReadonlySet<string>,
    rows: T[],
  ): T[] {
    if (!pii.size || this.canSeePii(ctx, projectId)) return rows;
    return rows.map((r) => ({
      ...r,
      sample: maskSample(r.sample as Record<string, unknown>, pii, false),
    }));
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
    // What each role may do in this organisation.
    const [tenant] = await tx.select({ rolePermissions: tenants.rolePermissions }).from(tenants);
    const matrix = roleMatrix(tenant?.rolePermissions);
    const byUser = new Map<string, Assignee>();
    for (const r of rows) {
      const role = r.role as Role;
      if (
        !(role in matrix) ||
        (!roleHasPermission(role, 'interviews.conduct', matrix) &&
          !roleHasPermission(role, 'dataentry.key', matrix))
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

  /**
   * Assigns (or unassigns, with null) cases; fresh ↔ assigned follows. Returns the count.
   * The cases are locked and checked again here, so a share-out planned on an older read does
   * not take a case someone claimed, started or finished meanwhile: only cases still in one of
   * `only.statuses` (and, with `only.unassigned`, still held by no one) change hands.
   */
  async assign(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    caseIds: string[],
    userId: string | null,
    via: string,
    only: { statuses?: string[]; unassigned?: boolean } = {},
  ): Promise<number> {
    if (userId) await this.assertAssignee(tx, projectId, userId);
    let changed: { id: string; from: string | null }[] = [];
    for (const part of chunks(caseIds)) {
      // In id order, so two share-outs at once wait for each other instead of deadlocking.
      const before = await tx
        .select({ id: cases.id, from: cases.assignedTo })
        .from(cases)
        .where(
          and(
            eq(cases.projectId, projectId),
            inArray(cases.id, part),
            ...(only.statuses ? [inArray(cases.status, only.statuses)] : []),
            ...(only.unassigned ? [isNull(cases.assignedTo)] : []),
          ),
        )
        .orderBy(asc(cases.id))
        .for('update');
      const ids = before.filter((b) => b.from !== userId).map((b) => b.id);
      if (!ids.length) continue;
      const done = await tx
        .update(cases)
        .set({
          assignedTo: userId,
          assignedAt: userId ? new Date() : null,
          status: userId
            ? sql`case when ${cases.status} = 'fresh' then 'assigned' else ${cases.status} end`
            : sql`case when ${cases.status} = 'assigned' then 'fresh' else ${cases.status} end`,
          updatedAt: new Date(),
        })
        .where(inArray(cases.id, ids))
        .returning({ id: cases.id });
      const hit = new Set(done.map((d) => d.id));
      changed = changed.concat(before.filter((b) => hit.has(b.id)));
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
   * The questionnaire new cases, frames and plans belong to: the one asked for (it must be
   * the project's), else the project's first; null while the project has none.
   */
  async questionnaireFor(tx: Tx, projectId: string, wanted?: string | null) {
    const rows = await tx
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(eq(questionnaires.projectId, projectId))
      .orderBy(asc(questionnaires.createdAt), asc(questionnaires.id));
    if (wanted) {
      if (!rows.some((r) => r.id === wanted))
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Questionnaire not found' });
      return wanted;
    }
    return rows[0]?.id ?? null;
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
    opts: { onlyCaseIds?: string[]; ruleId?: string; questionnaireId?: string | null } = {},
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
            // A questionnaire's rules, and the ones for the whole project.
            ...(opts.questionnaireId
              ? [
                  or(
                    eq(assignments.questionnaireId, opts.questionnaireId),
                    isNull(assignments.questionnaireId),
                  )!,
                ]
              : []),
          ),
        )
        .orderBy(asc(assignments.createdAt))
    ).filter((r) => eligible.has(r.userId));
    if (!rules.length) return 0;
    const pool = (
      await tx
        .select({
          id: cases.id,
          sample: cases.sample,
          samplePii: cases.samplePii,
          status: cases.status,
          priority: cases.priority,
          modePreference: cases.modePreference,
          questionnaireId: cases.questionnaireId,
        })
        .from(cases)
        .where(
          and(
            eq(cases.projectId, projectId),
            isNull(cases.assignedTo),
            eq(cases.status, 'fresh'),
            ...(opts.onlyCaseIds ? [inArray(cases.id, opts.onlyCaseIds)] : []),
            ...(opts.questionnaireId ? [ofQuestionnaire(opts.questionnaireId)!] : []),
          ),
        )
        .orderBy(sql`${cases.priority} desc`, asc(cases.id))
    ).map(({ samplePii, ...r }) => ({
      ...r,
      sample: this.pii.read({ sample: r.sample, samplePii }),
    }));
    const load = await tx
      .select({ userId: cases.assignedTo, n: sql<number>`count(*)::int` })
      .from(cases)
      .where(eq(cases.projectId, projectId))
      .groupBy(cases.assignedTo);
    const held = new Map(load.filter((l) => l.userId).map((l) => [l.userId!, l.n]));
    const taken = new Set<string>();
    let total = 0;
    // A questionnaire's rules hand out its cases (and those of no questionnaire); rules for the
    // whole project hand out any case. Questionnaire rules go first.
    const groups = [...new Set(rules.map((r) => r.questionnaireId))].sort((a, b) =>
      a === null ? 1 : b === null ? -1 : 0,
    );
    for (const group of groups)
      for (const strategy of STRATEGIES) {
        const mine = rules.filter((r) => r.kind === strategy.kind && r.questionnaireId === group);
        if (!mine.length) continue;
        const reachable =
          group === null
            ? pool
            : pool.filter((c) => c.questionnaireId === group || c.questionnaireId === null);
        for (const hand of strategy.plan({ rules: mine, pool: reachable, held, taken }))
          total += await this.assign(
            tx,
            ctx,
            projectId,
            hand.caseIds,
            hand.userId,
            `rule:${hand.ruleId}`,
            { statuses: ['fresh'], unassigned: true },
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
      .set({
        assignedTo: ctx.userId,
        assignedAt: new Date(),
        status: 'assigned',
        updatedAt: new Date(),
      })
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
      .set({ assignedTo: null, assignedAt: null, status: 'fresh', updatedAt: new Date() })
      .where(eq(cases.id, caseId));
    await this.events(tx, ctx.tenantId, ctx.userId, [
      { caseId, type: 'released', details: { from: c.assignedTo } },
    ]);
    return { released: true };
  }
}
