import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { MODES } from '@wansurvey/schema';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { CASES_REPO, type CaseQuery, type CasesRepo, type CasesTx } from './cases-repo.js';
import { compileRule, maskContact, maskSample, ruleError } from './case-logic.js';
import { deal, fairWeights, productivity, quotas, type Output } from './distribute.js';
import { daysBetween, windowsIn, type Frequency } from '../metrics/goal-periods.js';
import { CasesService } from './cases.service.js';
import { words } from './pii.js';

const round = (x: number) => Math.round(x * 1000) / 1000;
const PERM = { projectParam: 'projectId' } as const;
const READ = ['cases.read_all', 'cases.read_assigned'] as const;
const STATUSES = ['fresh', 'assigned', 'in_progress', 'finalised', 'withdrawn'] as const;

const ListQuery = z.object({
  /** The questionnaire whose cases to list (each questionnaire has its own). */
  questionnaireId: z.uuid().optional(),
  status: z.enum(STATUSES).optional(),
  /** A user id, `me` or `none`. */
  assignedTo: z.union([z.uuid(), z.enum(['me', 'none'])]).optional(),
  q: z.string().max(200).optional(),
  /** Rule-style filter over case.*, status, priority (evaluated on the server). */
  filter: z.string().max(2000).optional(),
  sort: z.enum(['externalId', 'priority', 'updatedAt']).default('externalId'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CasePatch = z.object({
  priority: z.number().int().min(-1000).max(1000).optional(),
  modePreference: z.enum(MODES).nullable().optional(),
  status: z.enum(['fresh', 'withdrawn']).optional(),
  sample: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const AssignBody = z
  .object({
    caseIds: z.array(z.uuid()).max(50_000).optional(),
    /** Assign every case matching this rule-style filter instead of a list. */
    filter: z.string().max(2000).optional(),
    onlyUnassigned: z.boolean().default(false),
    /** With a filter: only this questionnaire's cases. */
    questionnaireId: z.uuid().optional(),
    userId: z.uuid().nullable(),
  })
  .refine((b) => !!b.caseIds !== (b.filter !== undefined), 'Give either caseIds or filter');

const DistributeBody = z.object({
  /** Left out: every free case (of the questionnaire, when given). */
  caseIds: z.array(z.uuid()).min(1).max(50_000).optional(),
  questionnaireId: z.uuid().optional(),
  userIds: z.array(z.uuid()).min(1).max(500),
  /** Count the cases each person already holds, so the totals come out even. */
  balance: z.boolean().default(false),
  /**
   * even: the same to each; capacity: in proportion to `weights` or, without them, to each
   * person's goal; performance: to recent productivity; fair: even, moved at most 20% by
   * productivity (softened).
   */
  method: z.enum(['even', 'capacity', 'performance', 'fair']).default('even'),
  weights: z.record(z.uuid(), z.number().min(0).max(1_000_000)).optional(),
  /** The window productivity is measured over, in days. */
  days: z.number().int().min(7).max(90).default(14),
  /** At most this many open cases per person after the share-out. */
  cap: z.number().int().min(1).max(100_000).optional(),
});

/** How a share-out plan treats one person. */
interface ShareRow {
  userId: string;
  weight: number;
  /** Their part of what is shared (0 to 1). */
  share: number;
  /** Where the weight comes from. */
  source: 'even' | 'manual' | 'goal' | 'team_goal' | 'no_goal' | 'output';
  /** Open cases now (the ones being shared out aside). */
  held: number;
  receive: number;
  /** The most they may receive, when something limits it. */
  limit: number | null;
}

const FieldPatch = z.object({
  label: z.string().max(200).nullable().optional(),
  pii: z.boolean().optional(),
  type: z.enum(['text', 'number', 'date', 'code']).optional(),
});

/** Cases of a project: list, detail, edits, bulk assignment and distribution, sample fields. */
@ApiTags('cases')
@Controller('projects/:projectId')
export class CasesController {
  constructor(
    @Inject(CASES_REPO) private readonly repo: CasesRepo,
    private readonly audit: AuditService,
    private readonly svc: CasesService,
  ) {}

  /**
   * Paged list with counts per status. Interviewers and clerks only see cases assigned to them
   * and, in pool mode, the unassigned fresh cases they may claim. Personal fields are masked,
   * except an interviewer's own cases when the project shows them automatically (C4b).
   */
  @Get('cases')
  @RequirePermission(READ, PERM)
  list(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const settings = await this.svc.settings(t, projectId);
      const own = this.svc.restrictedToOwn(ctx, projectId);
      const base: CaseQuery = {
        projectId,
        questionnaireId: q.questionnaireId,
        ...(own
          ? { visibleTo: { userId: ctx.userId, pool: settings.assignmentMode === 'pool' } }
          : {}),
      };
      const pii = await this.svc.piiFields(t, projectId);
      const canSee = this.svc.canSeePii(ctx, projectId);
      const conds: CaseQuery = {
        ...base,
        status: q.status,
        assignedTo: q.assignedTo === 'me' ? ctx.userId : q.assignedTo,
        // Personal fields are searchable only by people allowed to see them: sealed ones by
        // whole words, through their keyed hashes (H1).
        search: q.q
          ? {
              term: q.q,
              hiddenFields: canSee ? [] : [...pii],
              tokens: canSee ? words(q.q).map((w) => this.svc.pii.token(w)) : [],
            }
          : undefined,
      };
      if (q.filter) {
        const err = ruleError(q.filter);
        if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
      }
      const order = { by: q.sort, dir: q.dir } as const;

      let rows;
      let total: number;
      if (q.filter) {
        // Rule filters run in the engine, over the already narrowed set.
        const match = compileRule(q.filter);
        const all = this.svc
          .forRules(ctx, projectId, pii, this.svc.openRows(await t.cases(conds, order)))
          .filter(match);
        total = all.length;
        rows = all.slice((q.page - 1) * q.limit, q.page * q.limit);
      } else {
        total = await t.countCases(conds);
        rows = this.svc.openRows(
          await t.cases(conds, order, { limit: q.limit, offset: (q.page - 1) * q.limit }),
        );
      }
      const { byStatus, completed, held } = await t.caseCounts(base);
      const fields = await t.fields(projectId);
      // Lists mask personal fields; clear values come from an audited reveal per case, or,
      // for an interviewer's own cases, automatically with the first view recorded.
      const auto = this.svc.autoReveal(ctx, projectId, settings);
      const clear = (r: { assignedTo: string | null }) => auto && r.assignedTo === ctx.userId;
      if (pii.size) await this.svc.recordAutoViews(t, ctx, projectId, rows.filter(clear), 'list');
      return {
        total,
        page: q.page,
        limit: q.limit,
        counts: byStatus,
        // Completed: finished with a complete interview (finalised also covers refusals…).
        completed,
        // Assigned: held by someone, whatever their state.
        held,
        fields,
        assignmentMode: settings.assignmentMode,
        caseExpiryDays: settings.fieldwork.caseExpiryDays,
        piiMasked: pii.size > 0,
        /** The caller's own cases are listed with personal data shown. */
        autoReveal: auto && pii.size > 0,
        canReveal: canSee,
        rows: rows.map((r) => ({
          ...r,
          sample: maskSample(r.sample as Record<string, unknown>, pii, clear(r)),
        })),
      };
    });
  }

  @Get('cases/:caseId')
  @RequirePermission(READ, PERM)
  detail(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Query('reveal') reveal?: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const settings = await this.svc.settings(t, projectId);
      const pool = settings.assignmentMode === 'pool';
      const c = await this.loadCase(t, ctx, projectId, caseId, pool);
      const canSee = this.svc.canSeePii(ctx, projectId);
      const pii = await this.svc.piiFields(t, projectId);
      const revealed = reveal === 'pii' && canSee;
      if (reveal === 'pii' && !canSee)
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You may not see personal data',
        });
      // Clear values are sent on an explicit, audited reveal, or automatically to the
      // interviewer holding the case when the project allows it (recorded once).
      const auto = this.svc.autoReveal(ctx, projectId, settings) && c.assignedTo === ctx.userId;
      const show = revealed || auto;
      if (auto && !revealed) await this.svc.recordAutoViews(t, ctx, projectId, [c], 'detail');
      if (revealed) {
        await t.audit(
          this.audit.fromContext(ctx, {
            action: 'case.pii_viewed',
            targetType: 'case',
            targetId: caseId,
            details: { projectId, externalId: c.externalId },
          }),
        );
      }
      const cs = await t.contacts(caseId);
      const history = await t.history(caseId);
      const hasPii = pii.size > 0 || cs.length > 0;
      // The same phone or e-mail in other projects, for people who see all cases.
      const elsewhere = can(ctx.memberships, 'cases.read_all', projectId)
        ? await this.svc.elsewhere(
            t,
            projectId,
            cs.filter((x) => x.type !== 'address'),
          )
        : [];
      const free = !c.assignedTo && c.status === 'fresh';
      // The sample keeps its history: the case this one substitutes, and its own substitute.
      const original = c.substituteFor ? await t.caseRef(c.substituteFor) : null;
      const substitute = await t.substituteOf(projectId, caseId);
      return {
        ...c,
        substitutes: original ?? null,
        substitutedBy: substitute ?? null,
        canSubstitute:
          can(ctx.memberships, 'cases.import', projectId) &&
          c.status === 'finalised' &&
          !!c.selectionRole &&
          !substitute,
        sample: maskSample(c.sample as Record<string, unknown>, pii, show),
        contacts: cs.map((x) => maskContact(x, show)),
        history,
        pii: { masked: hasPii && !show, canReveal: canSee && hasPii && !show, auto },
        assignmentMode: settings.assignmentMode,
        caseExpiryDays: settings.fieldwork.caseExpiryDays,
        elsewhere,
        canClaim: pool && free && can(ctx.memberships, 'cases.read_assigned', projectId),
        canRelease:
          c.status === 'assigned' &&
          (c.assignedTo === ctx.userId || can(ctx.memberships, 'cases.assign', projectId)),
        canForceRelease: !!c.checkedOutAt && can(ctx.memberships, 'cases.assign', projectId),
      };
    });
  }

  @Patch('cases/:caseId')
  @RequirePermission('cases.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(CasePatch) as object })
  update(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body(new ZodPipe(CasePatch)) body: z.infer<typeof CasePatch>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const before = await this.loadCase(t, ctx, projectId, caseId);
      // An expired case, or one closed with its questionnaire, is reopened as a fresh one.
      const reopen =
        body.status === 'fresh' &&
        before.status === 'finalised' &&
        (before.disposition === 'EXPIRED' || before.disposition === 'FIELDWORK_CLOSED');
      if (
        body.status &&
        !reopen &&
        before.status !== 'fresh' &&
        before.status !== 'assigned' &&
        before.status !== 'withdrawn'
      ) {
        throw new BadRequestException(
          'Cases with interviews in progress or finished cannot change status here',
        );
      }
      const status = reopen
        ? 'fresh'
        : body.status === 'fresh'
          ? before.assignedTo
            ? 'assigned'
            : 'fresh'
          : body.status;
      const sealed = body.sample
        ? this.svc.pii.seal(
            { ...(before.sample as Record<string, unknown>), ...body.sample },
            await this.svc.piiFields(t, projectId),
          )
        : null;
      const row = await t.updateCase(caseId, {
        priority: body.priority,
        modePreference: body.modePreference,
        status,
        reopen,
        sample: sealed
          ? { sample: sealed.sample, samplePii: sealed.samplePii, index: sealed.samplePiiIndex }
          : undefined,
      });
      const changed = Object.keys(body);
      await this.svc.events(t, ctx.tenantId, ctx.userId, [
        {
          caseId,
          type: status && status !== before.status ? 'status_changed' : 'edited',
          details: {
            fields: changed,
            ...(status && status !== before.status ? { from: before.status, to: status } : {}),
          },
        },
      ]);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'case.updated',
          targetType: 'case',
          targetId: caseId,
          // Field names only: the audit log must not copy personal data.
          details: {
            projectId,
            fields: changed,
            ...(body.sample ? { sampleFields: Object.keys(body.sample) } : {}),
          },
        }),
      );
      return row;
    });
  }

  /** Pool mode: take an unassigned case. 409 `ALREADY_TAKEN` when someone was quicker. */
  @Post('cases/:caseId/claim')
  @HttpCode(200)
  @RequirePermission('cases.read_assigned', PERM)
  claim(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await this.svc.claim(t, ctx, projectId, caseId);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'case.claimed',
          targetType: 'case',
          targetId: caseId,
          details: { projectId, externalId: row.externalId },
        }),
      );
      return { claimed: true };
    });
  }

  /** Give a case back: its holder, or someone who assigns cases. Only before it is started. */
  @Post('cases/:caseId/release')
  @HttpCode(200)
  @RequirePermission(['cases.read_assigned', 'cases.assign'], PERM)
  release(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const out = await this.svc.release(t, ctx, projectId, caseId);
      if (out.released)
        await t.audit(
          this.audit.fromContext(ctx, {
            action: 'case.released',
            targetType: 'case',
            targetId: caseId,
            details: { projectId },
          }),
        );
      return out;
    });
  }

  /** Assign or unassign a list of cases, or every case matching a filter. */
  @Post('cases/assign')
  @HttpCode(200)
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(AssignBody) as object })
  assign(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(AssignBody)) body: z.infer<typeof AssignBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.svc.project(t, projectId);
      let ids = body.caseIds;
      if (body.filter !== undefined) {
        const err = ruleError(body.filter || 'true');
        if (body.filter && err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
        const match = compileRule(body.filter);
        const all = this.svc.forRules(
          ctx,
          projectId,
          await this.svc.piiFields(t, projectId),
          this.svc.openRows(await t.cases({ projectId, questionnaireId: body.questionnaireId })),
        );
        ids = all.filter(match).map((c) => c.id);
      }
      if (body.onlyUnassigned && ids?.length) {
        const free = new Set(
          (await t.among(projectId, ids, { unassigned: true })).map((r) => r.id),
        );
        ids = ids.filter((id) => free.has(id));
      }
      // Finished or withdrawn cases are not handed out again.
      const workable = new Set(
        (
          await t.among(projectId, ids ?? [], {
            statuses: ['fresh', 'assigned', 'in_progress'],
          })
        ).map((r) => r.id),
      );
      const n = await this.svc.assign(t, ctx, projectId, [...workable], body.userId, 'manual', {
        statuses: ['fresh', 'assigned', 'in_progress'],
        unassigned: body.onlyUnassigned,
      });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'cases.assigned',
          targetType: 'project',
          targetId: projectId,
          details: {
            to: body.userId,
            count: n,
            ...(body.filter !== undefined ? { filter: body.filter } : {}),
          },
        }),
      );
      return { changed: n, skipped: (ids?.length ?? 0) - workable.size };
    });
  }

  /** What a share-out would do, without doing it. */
  @Post('cases/distribute/preview')
  @HttpCode(200)
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(DistributeBody, { io: 'input' }) as object })
  distributePreview(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(DistributeBody)) body: z.infer<typeof DistributeBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const { rows, free, skipped, movable } = await this.sharePlan(t, projectId, body);
      return { rows, free, skipped, count: movable.length };
    });
  }

  /**
   * Hands cases out at random among some people: evenly, or in proportion to capacity or
   * productivity. Cases being interviewed or finished stay where they are.
   */
  @Post('cases/distribute')
  @HttpCode(200)
  @RequirePermission('cases.assign', PERM)
  @ApiBody({ schema: z.toJSONSchema(DistributeBody, { io: 'input' }) as object })
  distribute(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(DistributeBody)) body: z.infer<typeof DistributeBody>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const { movable, rows, free, skipped } = await this.sharePlan(t, projectId, body);
      const hands = deal(movable, new Map(rows.map((r) => [r.userId, r.receive])));
      const perPerson: Record<string, number> = {};
      let changed = 0;
      for (const [userId, ids] of hands) {
        perPerson[userId] = ids.length;
        if (ids.length)
          changed += await this.svc.assign(t, ctx, projectId, ids, userId, 'random', {
            statuses: ['fresh', 'assigned'],
            // Planned on the free cases: only those still free.
            unassigned: !body.caseIds,
          });
      }
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'cases.assigned',
          targetType: 'project',
          targetId: projectId,
          details: {
            distributed: true,
            method: body.method,
            balance: body.balance,
            ...(body.cap ? { cap: body.cap } : {}),
            weights: Object.fromEntries(rows.map((r) => [r.userId, round(r.weight)])),
            perPerson,
            count: changed,
          },
        }),
      );
      return { changed, perPerson, free, skipped };
    });
  }

  /** The cases a share-out moves and how many each person gets. */
  private async sharePlan(t: CasesTx, projectId: string, body: z.infer<typeof DistributeBody>) {
    await this.svc.project(t, projectId);
    const people = [...new Set(body.userIds)];
    const caseIds = body.caseIds ?? (await t.freeCaseIds(projectId, body.questionnaireId));
    const movable: string[] = [];
    // Who holds each movable case now: those do not count in their load.
    const inHand = new Map<string, number>();
    for (const r of await t.among(projectId, caseIds, { statuses: ['fresh', 'assigned'] })) {
      movable.push(r.id);
      if (r.assignedTo) inHand.set(r.assignedTo, (inHand.get(r.assignedTo) ?? 0) + 1);
    }
    const held = new Map(people.map((p) => [p, 0]));
    (await t.openLoad(projectId, people)).forEach((r) =>
      held.set(r.userId, r.n - (inHand.get(r.userId) ?? 0)),
    );
    const base = body.balance ? held : new Map<string, number>();

    // The weights.
    let weights = new Map(people.map((p) => [p, 1]));
    const source = new Map<string, ShareRow['source']>(people.map((p) => [p, 'even']));
    if (body.method === 'capacity' && body.weights) {
      weights = new Map(people.map((p) => [p, body.weights![p] ?? 0]));
      people.forEach((p) => source.set(p, 'manual'));
    } else if (body.method === 'capacity') {
      const goals = await this.goalRates(t, projectId, people, body.questionnaireId);
      weights = goals.weights;
      goals.source.forEach((v, k) => source.set(k, v));
    } else if (body.method === 'performance' || body.method === 'fair') {
      const pace = productivity(
        people,
        await this.output(t, projectId, people, body.days, body.questionnaireId),
      );
      weights = body.method === 'fair' ? fairWeights(pace) : pace;
      people.forEach((p) => source.set(p, 'output'));
    }

    // The limits: the open-case cap, and for the fair share at most 20% over the even share.
    const room = new Map<string, number>();
    const total = movable.length + people.reduce((s, p) => s + (base.get(p) ?? 0), 0);
    for (const p of people) {
      let r = Infinity;
      if (body.cap) r = Math.max(0, body.cap - held.get(p)!);
      if (body.method === 'fair')
        r = Math.min(r, Math.max(0, Math.ceil((1.2 * total) / people.length) - (base.get(p) ?? 0)));
      if (r !== Infinity) room.set(p, r);
    }
    const amounts = quotas(people, weights, movable.length, base, room);
    const W = [...weights.values()].reduce((s, v) => s + v, 0) || 1;
    const rows: ShareRow[] = people.map((p) => ({
      userId: p,
      weight: weights.get(p)!,
      share: weights.get(p)! / W,
      source: source.get(p)!,
      held: held.get(p)!,
      receive: amounts.get(p)!,
      limit: room.get(p) ?? null,
    }));
    const given = rows.reduce((s, r) => s + r.receive, 0);
    return {
      movable,
      rows,
      free: movable.length - given,
      skipped: caseIds.length - movable.length,
    };
  }

  /**
   * Each person's goal pace (completes a day) from the goals in force today. People without
   * a goal of their own get the team goal's pace split among those chosen; with no goals at
   * all, everyone weighs the same.
   */
  private async goalRates(
    t: CasesTx,
    projectId: string,
    people: string[],
    questionnaireId: string | undefined,
  ) {
    const today = await t.projectToday(projectId);
    const goals = await t.goalsInForce(projectId, today, questionnaireId);
    const pace = (g: (typeof goals)[number]) =>
      (g.target * windowsIn(g.frequency as Frequency, g.startsOn, g.endsOn)) /
      daysBetween(g.startsOn, g.endsOn);
    const own = new Map<string, number>();
    let team = 0;
    for (const g of goals) {
      if (g.userId) own.set(g.userId, (own.get(g.userId) ?? 0) + pace(g));
      else team += pace(g);
    }
    const weights = new Map<string, number>();
    const source = new Map<string, ShareRow['source']>();
    const ownValues = people.filter((x) => own.has(x)).map((x) => own.get(x)!);
    const fallback = team
      ? team / people.length
      : ownValues.length
        ? ownValues.reduce((s, v) => s + v, 0) / ownValues.length
        : 1;
    for (const x of people) {
      if (own.has(x)) {
        weights.set(x, own.get(x)!);
        source.set(x, 'goal');
      } else {
        weights.set(x, fallback);
        source.set(x, team ? 'team_goal' : 'no_goal');
      }
    }
    return { weights, source };
  }

  /** Completes and days worked by each person over the last `days` days. */
  private async output(
    t: CasesTx,
    projectId: string,
    people: string[],
    days: number,
    questionnaireId: string | undefined,
  ): Promise<Map<string, Output>> {
    const rows = await t.output(projectId, people, days, questionnaireId);
    return new Map(rows.map((r) => [r.userId, { completes: r.completes, days: r.days }]));
  }

  /** People cases can be assigned to, with their workload. */
  @Get('assignees')
  @RequirePermission('cases.assign', PERM)
  assignees(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.svc.project(t, projectId);
      const people = await this.svc.assignees(t, projectId);
      const load = await t.workload(projectId);
      return people.map((p) => ({
        ...p,
        workload: Object.fromEntries(
          load.filter((l) => l.userId === p.userId).map((l) => [l.status, l.n]),
        ),
      }));
    });
  }

  // ---- Sample dictionary ----------------------------------------------------

  /** Fields of the project's sample (`case.*`), for the case list and the designer. */
  @Get('sample-fields')
  @RequirePermission(['cases.read_all', 'cases.read_assigned', 'questionnaires.read'], PERM)
  sampleFields(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.repo.inTenant(ctx.tenantId, (t) => t.fields(projectId));
  }

  @Put('sample-fields/:name')
  @RequirePermission('cases.edit', PERM)
  @ApiBody({ schema: z.toJSONSchema(FieldPatch) as object })
  updateField(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('name') name: string,
    @Body(new ZodPipe(FieldPatch)) body: z.infer<typeof FieldPatch>,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const row = await t.updateField(projectId, name, body);
      if (!row) throw new NotFoundException('Field not found');
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'sample_field.updated',
          targetType: 'project',
          targetId: projectId,
          details: { field: name, ...body },
        }),
      );
      return row;
    });
  }

  // -------------------------------------------------------------------------

  private async loadCase(
    t: CasesTx,
    ctx: AuthContext,
    projectId: string,
    caseId: string,
    pool = false,
  ) {
    const [c] = this.svc.openRows(
      await t.cases({
        projectId,
        ids: [caseId],
        ...(this.svc.restrictedToOwn(ctx, projectId)
          ? { visibleTo: { userId: ctx.userId, pool } }
          : {}),
      }),
    );
    if (!c) throw new NotFoundException('Case not found');
    return c;
  }
}
