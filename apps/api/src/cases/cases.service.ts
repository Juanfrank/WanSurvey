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
import { eq, isNull, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { can } from '../common/auth-context.js';
import { CONFIG, type AppConfig } from '../config.js';
import type { Tx } from '../db/database.js';
import { cases, users } from '../db/schema.js';
import type { ProjectView } from '../projects/org-repo.js';
import { maskSample } from './case-logic.js';
import { PgCasesTx, type CasesTx } from './cases-repo.js';
import { PiiCipher } from './pii.js';
import { rememberedProject } from './project-memo.js';
import { STRATEGIES } from './strategies.js';

export type { Assignee } from './cases-repo.js';
import type { Assignee } from './cases-repo.js';

/** A transaction of either engine; a Drizzle one is wrapped for the moment (modules not yet moved). */
export type AnyCasesTx = Tx | CasesTx;

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

  /** The engine-neutral view of a transaction; a Drizzle one is wrapped. */
  private view(tx: AnyCasesTx, tenantId = ''): CasesTx {
    return 'piiFields' in tx ? tx : new PgCasesTx(tx as Tx, tenantId, this.audit);
  }

  async project(tx: AnyCasesTx, projectId: string): Promise<ProjectView> {
    if (!('piiFields' in tx)) {
      const known = rememberedProject(tx, projectId);
      if (known) return known as unknown as ProjectView;
    }
    const p = await this.view(tx).project(projectId);
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  async piiFields(tx: AnyCasesTx, projectId: string): Promise<Set<string>> {
    return this.view(tx).piiFields(projectId);
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
  async assignees(tx: AnyCasesTx, projectId: string): Promise<Assignee[]> {
    const t = this.view(tx);
    const rows = await t.assigneeRows(projectId);
    // What each role may do in this organisation.
    const matrix = roleMatrix(await t.rolePermissions());
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

  async assertAssignee(tx: AnyCasesTx, projectId: string, userId: string) {
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
    tx: AnyCasesTx,
    tenantId: string,
    actorUserId: string | null,
    rows: { caseId: string; type: string; details?: Record<string, unknown> }[],
  ) {
    if (!rows.length) return;
    await this.view(tx, tenantId).events(rows.map((r) => ({ ...r, actorUserId })));
  }

  /**
   * Assigns (or unassigns, with null) cases; fresh ↔ assigned follows. Returns the count.
   * The cases are locked and checked again here, so a share-out planned on an older read does
   * not take a case someone claimed, started or finished meanwhile: only cases still in
   * `only.statuses` (and, with `only.unassigned`, still held by no one) change hands.
   */
  async assign(
    tx: AnyCasesTx,
    ctx: AuthContext,
    projectId: string,
    caseIds: string[],
    userId: string | null,
    via: string,
    only: { statuses?: string[]; unassigned?: boolean } = {},
  ): Promise<number> {
    if (userId) await this.assertAssignee(tx, projectId, userId);
    const changed = await this.view(tx, ctx.tenantId).assign(projectId, caseIds, userId, only);
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
  async questionnaireFor(tx: AnyCasesTx, projectId: string, wanted?: string | null) {
    const ids = await this.view(tx).questionnaireIds(projectId);
    if (wanted) {
      if (!ids.includes(wanted))
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Questionnaire not found' });
      return wanted;
    }
    return ids[0] ?? null;
  }

  /** The project's settings, with defaults. */
  async settings(tx: AnyCasesTx, projectId: string): Promise<ProjectSettings> {
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
    tx: AnyCasesTx,
    ctx: AuthContext,
    projectId: string,
    shown: { id: string; externalId: string }[],
    via: 'detail' | 'list',
  ) {
    if (!shown.length) return;
    const t = this.view(tx, ctx.tenantId);
    const seen = await t.piiViewsSeen(
      ctx.userId,
      shown.map((c) => c.id),
    );
    for (const c of shown) {
      if (seen.has(c.id)) continue;
      await t.audit(
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
    tx: AnyCasesTx,
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
      const rows = await this.view(tx).contactMatches(projectId, part);
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
  async elsewhere(tx: AnyCasesTx, projectId: string, cs: { type: string; value: string }[]) {
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
    tx: AnyCasesTx,
    ctx: AuthContext,
    projectId: string,
    opts: { onlyCaseIds?: string[]; ruleId?: string; questionnaireId?: string | null } = {},
  ): Promise<number> {
    const t = this.view(tx, ctx.tenantId);
    const eligible = new Set((await this.assignees(tx, projectId)).map((a) => a.userId));
    const rules = (
      await t.rules(projectId, {
        activeOnly: true,
        ruleId: opts.ruleId,
        // A questionnaire's rules, and the ones for the whole project.
        questionnaireId: opts.questionnaireId ?? undefined,
      })
    ).filter((r) => eligible.has(r.userId));
    if (!rules.length) return 0;
    const pool = (
      await t.cases(
        {
          projectId,
          status: 'fresh',
          assignedTo: 'none',
          ids: opts.onlyCaseIds,
          questionnaireId: opts.questionnaireId ?? undefined,
        },
        { by: 'priority', dir: 'desc' },
      )
    ).map(({ samplePii, ...r }) => ({
      ...r,
      sample: this.pii.read({ sample: r.sample, samplePii }),
    }));
    const load = await t.heldTotals(projectId);
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
  async claim(tx: AnyCasesTx, ctx: AuthContext, projectId: string, caseId: string) {
    const settings = await this.settings(tx, projectId);
    if (settings.assignmentMode !== 'pool')
      throw new BadRequestException({
        code: 'NOT_POOL',
        message: 'Cases of this project are assigned by a supervisor',
      });
    await this.assertAssignee(tx, projectId, ctx.userId);
    const t = this.view(tx, ctx.tenantId);
    const row = await t.claim(projectId, caseId, ctx.userId);
    if (!row) {
      if (!(await t.caseHolder(projectId, caseId))) throw new NotFoundException('Case not found');
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
  async release(tx: AnyCasesTx, ctx: AuthContext, projectId: string, caseId: string) {
    const t = this.view(tx, ctx.tenantId);
    const c = await t.caseHolder(projectId, caseId);
    const manager = can(ctx.memberships, 'cases.assign', projectId);
    if (!c || (!manager && c.assignedTo !== ctx.userId))
      throw new NotFoundException('Case not found');
    if (!c.assignedTo) return { released: false };
    if (c.status !== 'assigned')
      throw new BadRequestException({
        code: 'NOT_RELEASABLE',
        message: 'Only cases not yet started can be released',
      });
    await t.release(caseId);
    await this.events(tx, ctx.tenantId, ctx.userId, [
      { caseId, type: 'released', details: { from: c.assignedTo } },
    ]);
    return { released: true };
  }
}
