import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Auth, RequirePermission, can, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import { Database, type Tx } from '../db/database.js';
import {
  caseEvents,
  cases,
  contacts,
  interviewerGoals,
  projects,
  sampleFields,
  users,
} from '../db/schema.js';
import { compileRule, maskContact, maskSample, ruleError } from './case-logic.js';
import { deal, fairWeights, productivity, quotas, type Output } from './distribute.js';
import { daysBetween, windowsIn, type Frequency } from '../metrics/goal-periods.js';
import { CasesService, ofQuestionnaire } from './cases.service.js';
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
    private readonly database: Database,
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const settings = await this.svc.settings(tx, projectId);
      const own = this.svc.restrictedToOwn(ctx, projectId);
      const base: SQL[] = [eq(cases.projectId, projectId)];
      if (q.questionnaireId) base.push(ofQuestionnaire(q.questionnaireId)!);
      if (own) base.push(this.visibleToOwn(ctx, settings.assignmentMode === 'pool'));
      const conds = [...base];
      if (q.status) conds.push(eq(cases.status, q.status));
      if (q.assignedTo === 'none') conds.push(isNull(cases.assignedTo));
      else if (q.assignedTo === 'me') conds.push(eq(cases.assignedTo, ctx.userId));
      else if (q.assignedTo) conds.push(eq(cases.assignedTo, q.assignedTo));
      const pii = await this.svc.piiFields(tx, projectId);
      const canSee = this.svc.canSeePii(ctx, projectId);
      if (q.q) {
        const term = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
        // Personal fields are searchable only by people allowed to see them: sealed ones by
        // whole words, through their keyed hashes (H1).
        const searchable = canSee
          ? sql`${cases.sample}::text`
          : sql`(${cases.sample} - ${sql.raw(`'{${[...pii].map((f) => f.replace(/[^A-Za-z0-9_]/g, '')).join(',')}}'::text[]`)})::text`;
        const tokens = canSee ? words(q.q).map((w) => this.svc.pii.token(w)) : [];
        conds.push(
          or(
            ilike(cases.externalId, term),
            sql`${searchable} ilike ${term}`,
            ...(tokens.length
              ? [sql`${cases.samplePiiIndex} @> ${sql.param(tokens)}::text[]`]
              : []),
          )!,
        );
      }
      if (q.filter) {
        const err = ruleError(q.filter);
        if (err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
      }
      const order =
        q.sort === 'priority'
          ? cases.priority
          : q.sort === 'updatedAt'
            ? cases.updatedAt
            : cases.externalId;
      const by = q.dir === 'desc' ? desc(order) : asc(order);

      let rows;
      let total: number;
      if (q.filter) {
        // Rule filters run in the engine, over the already narrowed set.
        const match = compileRule(q.filter);
        const all = this.svc
          .forRules(
            ctx,
            projectId,
            pii,
            this.svc.openRows(
              await this.svc
                .selectCases(tx)
                .where(and(...conds))
                .orderBy(by, asc(cases.id)),
            ),
          )
          .filter(match);
        total = all.length;
        rows = all.slice((q.page - 1) * q.limit, q.page * q.limit);
      } else {
        const [c] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(cases)
          .where(and(...conds));
        total = c?.n ?? 0;
        rows = this.svc.openRows(
          await this.svc
            .selectCases(tx)
            .where(and(...conds))
            .orderBy(by, asc(cases.id))
            .limit(q.limit)
            .offset((q.page - 1) * q.limit),
        );
      }
      const counts = await tx
        .select({ status: cases.status, n: sql<number>`count(*)::int` })
        .from(cases)
        .where(and(...base))
        .groupBy(cases.status);
      // Completed: finished with a complete interview (finalised also covers refusals…).
      const [done] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(cases)
        .where(and(...base, eq(cases.status, 'finalised'), eq(cases.disposition, 'COMPLETE')));
      // Assigned: held by someone, whatever their state.
      const [held] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(cases)
        .where(and(...base, isNotNull(cases.assignedTo)));
      const fields = await this.fields(tx, projectId);
      // Lists mask personal fields; clear values come from an audited reveal per case, or,
      // for an interviewer's own cases, automatically with the first view recorded.
      const auto = this.svc.autoReveal(ctx, projectId, settings);
      const clear = (r: { assignedTo: string | null }) => auto && r.assignedTo === ctx.userId;
      if (pii.size) await this.svc.recordAutoViews(tx, ctx, projectId, rows.filter(clear), 'list');
      return {
        total,
        page: q.page,
        limit: q.limit,
        counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        completed: done?.n ?? 0,
        held: held?.n ?? 0,
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const settings = await this.svc.settings(tx, projectId);
      const pool = settings.assignmentMode === 'pool';
      const c = await this.loadCase(tx, ctx, projectId, caseId, pool);
      const canSee = this.svc.canSeePii(ctx, projectId);
      const pii = await this.svc.piiFields(tx, projectId);
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
      if (auto && !revealed) await this.svc.recordAutoViews(tx, ctx, projectId, [c], 'detail');
      if (revealed) {
        await this.audit.record(
          tx,
          ctx.tenantId,
          this.audit.fromContext(ctx, {
            action: 'case.pii_viewed',
            targetType: 'case',
            targetId: caseId,
            details: { projectId, externalId: c.externalId },
          }),
        );
      }
      const cs = await tx
        .select({
          id: contacts.id,
          type: contacts.type,
          value: contacts.value,
          label: contacts.label,
          valid: contacts.valid,
          consent: contacts.consent,
          lat: contacts.lat,
          lng: contacts.lng,
          geocodeQuality: contacts.geocodeQuality,
        })
        .from(contacts)
        .where(eq(contacts.caseId, caseId))
        .orderBy(asc(contacts.createdAt));
      const history = await tx
        .select({
          type: caseEvents.type,
          details: caseEvents.details,
          at: caseEvents.at,
          actor: users.name,
        })
        .from(caseEvents)
        .leftJoin(users, eq(users.id, caseEvents.actorUserId))
        .where(eq(caseEvents.caseId, caseId))
        .orderBy(desc(caseEvents.at))
        .limit(200);
      const hasPii = pii.size > 0 || cs.length > 0;
      // The same phone or e-mail in other projects, for people who see all cases.
      const elsewhere = can(ctx.memberships, 'cases.read_all', projectId)
        ? await this.svc.elsewhere(
            tx,
            projectId,
            cs.filter((x) => x.type !== 'address'),
          )
        : [];
      const free = !c.assignedTo && c.status === 'fresh';
      // The sample keeps its history: the case this one substitutes, and its own substitute.
      const [original] = c.substituteFor
        ? await tx
            .select({ id: cases.id, externalId: cases.externalId })
            .from(cases)
            .where(eq(cases.id, c.substituteFor))
        : [];
      const [substitute] = await tx
        .select({ id: cases.id, externalId: cases.externalId })
        .from(cases)
        .where(and(eq(cases.projectId, projectId), eq(cases.substituteFor, caseId)));
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.loadCase(tx, ctx, projectId, caseId);
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
      const [row] = await tx
        .update(cases)
        .set({
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.modePreference !== undefined ? { modePreference: body.modePreference } : {}),
          ...(status ? { status } : {}),
          ...(reopen ? { disposition: null, assignedTo: null, assignedAt: null } : {}),
          ...(body.sample
            ? this.svc.pii.seal(
                { ...(before.sample as Record<string, unknown>), ...body.sample },
                await this.svc.piiFields(tx, projectId),
              )
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(cases.id, caseId))
        .returning({ id: cases.id, status: cases.status, priority: cases.priority });
      const changed = Object.keys(body);
      await this.svc.events(tx, ctx.tenantId, ctx.userId, [
        {
          caseId,
          type: status && status !== before.status ? 'status_changed' : 'edited',
          details: {
            fields: changed,
            ...(status && status !== before.status ? { from: before.status, to: status } : {}),
          },
        },
      ]);
      await this.audit.record(
        tx,
        ctx.tenantId,
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.svc.claim(tx, ctx, projectId, caseId);
      await this.audit.record(
        tx,
        ctx.tenantId,
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const out = await this.svc.release(tx, ctx, projectId, caseId);
      if (out.released)
        await this.audit.record(
          tx,
          ctx.tenantId,
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.svc.project(tx, projectId);
      let ids = body.caseIds;
      if (body.filter !== undefined) {
        const err = ruleError(body.filter || 'true');
        if (body.filter && err) throw new BadRequestException({ code: 'BAD_FILTER', message: err });
        const match = compileRule(body.filter);
        const all = this.svc.forRules(
          ctx,
          projectId,
          await this.svc.piiFields(tx, projectId),
          this.svc.openRows(
            await this.svc
              .selectCases(tx)
              .where(and(eq(cases.projectId, projectId), ofQuestionnaire(body.questionnaireId))),
          ),
        );
        ids = all.filter(match).map((c) => c.id);
      }
      if (body.onlyUnassigned && ids?.length) {
        const free = new Set<string>();
        for (let i = 0; i < ids.length; i += 1000) {
          const rows = await tx
            .select({ id: cases.id })
            .from(cases)
            .where(and(inArray(cases.id, ids.slice(i, i + 1000)), isNull(cases.assignedTo)));
          rows.forEach((r) => free.add(r.id));
        }
        ids = ids.filter((id) => free.has(id));
      }
      // Finished or withdrawn cases are not handed out again.
      const workable = new Set<string>();
      for (let i = 0; i < (ids ?? []).length; i += 1000) {
        const rows = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.projectId, projectId),
              inArray(cases.id, ids!.slice(i, i + 1000)),
              inArray(cases.status, ['fresh', 'assigned', 'in_progress']),
            ),
          );
        rows.forEach((r) => workable.add(r.id));
      }
      const n = await this.svc.assign(tx, ctx, projectId, [...workable], body.userId, 'manual', {
        statuses: ['fresh', 'assigned', 'in_progress'],
        unassigned: body.onlyUnassigned,
      });
      await this.audit.record(
        tx,
        ctx.tenantId,
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const { rows, free, skipped, movable } = await this.sharePlan(tx, projectId, body);
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const { movable, rows, free, skipped } = await this.sharePlan(tx, projectId, body);
      const hands = deal(movable, new Map(rows.map((r) => [r.userId, r.receive])));
      const perPerson: Record<string, number> = {};
      let changed = 0;
      for (const [userId, ids] of hands) {
        perPerson[userId] = ids.length;
        if (ids.length)
          changed += await this.svc.assign(tx, ctx, projectId, ids, userId, 'random', {
            statuses: ['fresh', 'assigned'],
            // Planned on the free cases: only those still free.
            unassigned: !body.caseIds,
          });
      }
      await this.audit.record(
        tx,
        ctx.tenantId,
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
  private async sharePlan(tx: Tx, projectId: string, body: z.infer<typeof DistributeBody>) {
    await this.svc.project(tx, projectId);
    const people = [...new Set(body.userIds)];
    const caseIds =
      body.caseIds ??
      (
        await tx
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.projectId, projectId),
              eq(cases.status, 'fresh'),
              isNull(cases.assignedTo),
              ofQuestionnaire(body.questionnaireId),
            ),
          )
      ).map((c) => c.id);
    const movable: string[] = [];
    // Who holds each movable case now: those do not count in their load.
    const inHand = new Map<string, number>();
    for (let i = 0; i < caseIds.length; i += 1000) {
      const rows = await tx
        .select({ id: cases.id, assignedTo: cases.assignedTo })
        .from(cases)
        .where(
          and(
            eq(cases.projectId, projectId),
            inArray(cases.id, caseIds.slice(i, i + 1000)),
            inArray(cases.status, ['fresh', 'assigned']),
          ),
        );
      for (const r of rows) {
        movable.push(r.id);
        if (r.assignedTo) inHand.set(r.assignedTo, (inHand.get(r.assignedTo) ?? 0) + 1);
      }
    }
    const held = new Map(people.map((p) => [p, 0]));
    const open = await tx
      .select({ userId: cases.assignedTo, n: sql<number>`count(*)::int` })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          inArray(cases.assignedTo, people),
          inArray(cases.status, ['assigned', 'in_progress']),
        ),
      )
      .groupBy(cases.assignedTo);
    open.forEach((r) => held.set(r.userId!, r.n - (inHand.get(r.userId!) ?? 0)));
    const base = body.balance ? held : new Map<string, number>();

    // The weights.
    let weights = new Map(people.map((p) => [p, 1]));
    const source = new Map<string, ShareRow['source']>(people.map((p) => [p, 'even']));
    if (body.method === 'capacity' && body.weights) {
      weights = new Map(people.map((p) => [p, body.weights![p] ?? 0]));
      people.forEach((p) => source.set(p, 'manual'));
    } else if (body.method === 'capacity') {
      const goals = await this.goalRates(tx, projectId, people, body.questionnaireId);
      weights = goals.weights;
      goals.source.forEach((v, k) => source.set(k, v));
    } else if (body.method === 'performance' || body.method === 'fair') {
      const pace = productivity(
        people,
        await this.output(tx, projectId, people, body.days, body.questionnaireId),
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
    tx: Tx,
    projectId: string,
    people: string[],
    questionnaireId: string | undefined,
  ) {
    const [p] = await tx
      .select({ timezone: projects.timezone })
      .from(projects)
      .where(eq(projects.id, projectId));
    const today = (
      (await tx.execute(
        sql`select (now() at time zone ${p?.timezone ?? 'UTC'})::date::text as d`,
      )) as unknown as { d: string }[]
    )[0]!.d;
    const goals = await tx
      .select({
        userId: interviewerGoals.userId,
        frequency: interviewerGoals.frequency,
        startsOn: interviewerGoals.startsOn,
        endsOn: interviewerGoals.endsOn,
        target: interviewerGoals.target,
      })
      .from(interviewerGoals)
      .where(
        and(
          eq(interviewerGoals.projectId, projectId),
          lte(interviewerGoals.startsOn, today),
          gte(interviewerGoals.endsOn, today),
          questionnaireId
            ? or(
                isNull(interviewerGoals.questionnaireId),
                eq(interviewerGoals.questionnaireId, questionnaireId),
              )
            : undefined,
        ),
      );
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
    tx: Tx,
    projectId: string,
    people: string[],
    days: number,
    questionnaireId: string | undefined,
  ): Promise<Map<string, Output>> {
    const rows = (await tx.execute(sql`
      select i.interviewer_id::text as "userId",
        count(*) filter (where i.disposition = 'COMPLETE'
          and i.status in ('submitted', 'in_review', 'approved', 'returned'))::int as completes,
        count(distinct (i.submitted_at at time zone coalesce(p.timezone, 'UTC'))::date)::int as days
      from interviews i
      join projects p on p.id = i.project_id
      join questionnaire_versions v on v.id = i.questionnaire_version_id
      where i.project_id = ${projectId}
        -- Second entries of paper forms are checks, not output (as in the metrics).
        and i.entry_pass = 1
        and i.interviewer_id in (${sql.join(
          people.map((x) => sql`${x}::uuid`),
          sql`, `,
        )})
        and i.submitted_at >= now() - make_interval(days => ${days})
        ${questionnaireId ? sql`and v.questionnaire_id = ${questionnaireId}` : sql``}
      group by i.interviewer_id
    `)) as unknown as ({ userId: string } & Output)[];
    return new Map(rows.map((r) => [r.userId, { completes: r.completes, days: r.days }]));
  }

  /** People cases can be assigned to, with their workload. */
  @Get('assignees')
  @RequirePermission('cases.assign', PERM)
  assignees(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.svc.project(tx, projectId);
      const people = await this.svc.assignees(tx, projectId);
      const load = await tx
        .select({ userId: cases.assignedTo, status: cases.status, n: sql<number>`count(*)::int` })
        .from(cases)
        .where(eq(cases.projectId, projectId))
        .groupBy(cases.assignedTo, cases.status);
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
    return this.database.withTenant(ctx.tenantId, (tx) => this.fields(tx, projectId));
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
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(sampleFields)
        .set(body)
        .where(and(eq(sampleFields.projectId, projectId), eq(sampleFields.name, name)))
        .returning();
      if (!row) throw new NotFoundException('Field not found');
      await this.audit.record(
        tx,
        ctx.tenantId,
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

  private fields(tx: Tx, projectId: string) {
    return tx
      .select({
        name: sampleFields.name,
        label: sampleFields.label,
        type: sampleFields.type,
        pii: sampleFields.pii,
      })
      .from(sampleFields)
      .where(eq(sampleFields.projectId, projectId))
      .orderBy(asc(sampleFields.position), asc(sampleFields.name));
  }

  /** Cases someone without `cases.read_all` may see: theirs, and in pool mode the free ones. */
  private visibleToOwn(ctx: AuthContext, pool: boolean): SQL {
    const mine = eq(cases.assignedTo, ctx.userId);
    return pool ? or(mine, and(isNull(cases.assignedTo), eq(cases.status, 'fresh')))! : mine;
  }

  private async loadCase(
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    caseId: string,
    pool = false,
  ) {
    const conds = [eq(cases.id, caseId), eq(cases.projectId, projectId)];
    if (this.svc.restrictedToOwn(ctx, projectId)) conds.push(this.visibleToOwn(ctx, pool));
    const [c] = this.svc.openRows(await this.svc.selectCases(tx).where(and(...conds)));
    if (!c) throw new NotFoundException('Case not found');
    return c;
  }
}
