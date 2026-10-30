import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  baseWeight,
  planChecks,
  planDesign,
  planSizes,
  selectSample,
  type FrameStats,
  type FrameUnit,
} from '@wansurvey/logic';
import { SamplingPlanInput } from '@wansurvey/schema/sampling';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { randomToken } from '../common/crypto.js';
import {
  SAMPLE_REPO,
  type PlanView,
  type SampleRepo,
  type SampleTx,
  type UnitView,
} from './sampling-repo.js';
import { compileRule, ruleError } from '../cases/case-logic.js';
import { chunks, CasesService } from '../cases/cases.service.js';
import { CrossChecker } from './cross-check.js';

export const ReleaseBody = z.object({
  count: z.number().int().min(1).max(10_000),
  stratum: z.string().max(200).nullable().optional(),
  reason: z.string().trim().min(1).max(500),
});
export const SubstituteBody = z.object({ reason: z.string().trim().min(1).max(500) });
/** Another batch from the units never selected, added to the cases already in the sample. */
export const BatchBody = z.object({
  count: z.number().int().min(1).max(100_000),
  reason: z.string().trim().min(1).max(500),
});
/** Designs whose probabilities can be recomputed exactly when a batch is added. */
const BATCH_METHODS = ['srs', 'systematic', 'stratified'];
export const FieldCasesBody = z.object({
  count: z.number().int().min(1).max(5000),
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/),
  /** Where and when they are taken (time-location designs), kept in the case data. */
  cell: z.string().trim().max(200).optional(),
});

type Plan = PlanView;
type Q = string | null;
type Unit = UnitView;

/**
 * The sampling selector (S1): the frame of units, the plan, the selection with its
 * probabilities of inclusion, reserves released by decision, and substitutes by rule. Units and
 * cases of a selected sample are never deleted or silently replaced (decision 6).
 */
@Injectable()
export class SamplingService {
  constructor(
    @Inject(SAMPLE_REPO) private readonly repo: SampleRepo,
    private readonly casesService: CasesService,
    private readonly audit: AuditService,
  ) {}

  private input(plan: Plan | null | undefined): SamplingPlanInput {
    return SamplingPlanInput.parse(
      plan
        ? {
            source: plan.source,
            design: plan.design,
            size: plan.size,
            eligibility: plan.eligibility,
            exclusions: plan.exclusions,
            quotas: plan.quotas,
            substitution: plan.substitution,
            crossChecks: plan.crossChecks,
          }
        : {},
    );
  }

  private plan(t: SampleTx, projectId: string, q: Q, lock = false) {
    return t.plan(projectId, q, lock);
  }

  private units(t: SampleTx, projectId: string, q: Q) {
    return t.units(projectId, q);
  }

  /** The plan's cross-case checks against cases already answered (null when there are none). */
  private checker(t: SampleTx, projectId: string, input: SamplingPlanInput) {
    return CrossChecker.load(t, this.casesService.pii, projectId, input.crossChecks);
  }

  /**
   * Eligibility, exclusions and cross-case checks applied to the frame (units keep a reason
   * when out: ineligible, excluded, cross_check).
   */
  private screen(input: SamplingPlanInput, units: Unit[], checker: CrossChecker | null = null) {
    const eligible = compileRule(input.eligibility);
    const excluded = input.exclusions?.trim() ? compileRule(input.exclusions) : () => false;
    return units.map((u) => {
      const c = {
        sample: this.casesService.pii.read(u),
        status: 'fresh',
        priority: 0,
        modePreference: null,
      };
      const why = !eligible(c)
        ? 'ineligible'
        : excluded(c)
          ? 'excluded'
          : checker?.check({
                sample: c.sample,
                contacts: u.contacts as { type: string; value: string }[],
              }) != null
            ? 'cross_check'
            : null;
      return { unit: u, sample: c.sample, out: why };
    });
  }

  private stats(
    input: SamplingPlanInput,
    screened: ReturnType<SamplingService['screen']>,
  ): FrameStats & {
    byStratum: { stratum: string; units: number }[];
  } {
    const d = input.design;
    const inside = screened.filter((s) => !s.out);
    const strata = new Map<string, number>();
    const clusters = new Set<string>();
    for (const s of inside) {
      if (d.strataVar) {
        const k = String(s.sample[d.strataVar] ?? '');
        strata.set(k, (strata.get(k) ?? 0) + 1);
      }
      if (d.clusterVar) clusters.add(String(s.sample[d.clusterVar] ?? ''));
    }
    return {
      units: screened.length,
      eligible: inside.length,
      excluded: screened.length - inside.length,
      strata: strata.size,
      smallestStratum: strata.size ? Math.min(...strata.values()) : null,
      clusters: clusters.size,
      byStratum: [...strata]
        .map(([stratum, units]) => ({ stratum, units }))
        .sort((a, b) => a.stratum.localeCompare(b.stratum)),
    };
  }

  private frameUnitsFor(input: SamplingPlanInput, screened: ReturnType<SamplingService['screen']>) {
    const d = input.design;
    return screened
      .filter((s) => !s.out)
      .map((s): FrameUnit => ({
        id: s.unit.id,
        stratum: d.strataVar ? String(s.sample[d.strataVar] ?? '') : null,
        cluster: d.clusterVar ? String(s.sample[d.clusterVar] ?? '') : null,
        size: d.sizeVar ? Number(s.sample[d.sizeVar]) || 1 : null,
        sortKey: d.sortVar ? (s.sample[d.sortVar] as string | number | null) : null,
      }));
  }

  /** The plan, its sizes and checks, the frame in numbers and what has been selected. */
  get(tenantId: string, projectId: string, questionnaireId?: string) {
    return this.repo.inTenant(tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q);
      const input = this.input(plan);
      const units = await this.units(t, projectId, q);
      const screened = this.screen(input, units, await this.checker(t, projectId, input));
      const stats = this.stats(input, screened);
      const crossChecked = screened.filter((s) => s.out === 'cross_check').length;
      const roles = await t.selectionRoles(projectId, q);
      const reservesLeft = units.filter((u) => u.role === 'reserve' && !u.caseId).length;
      // Never selected: what a further batch can draw from.
      const unitsLeft = units.filter((u) => !u.role && !u.caseId && u.eligible !== false).length;
      const sources = [...new Set(units.map((u) => u.sourceLabel ?? ''))].map((label) => ({
        label,
        units: units.filter((u) => (u.sourceLabel ?? '') === label).length,
      }));
      return {
        questionnaireId: q,
        plan: input,
        status: plan?.status ?? 'draft',
        seed: plan?.seed ?? null,
        selectedAt: plan?.selectedAt ?? null,
        result: plan?.result ?? null,
        sizes: planSizes(input, stats.eligible || undefined),
        checks: planChecks(input, stats),
        frame: { ...stats, sources, crossChecked },
        cases: Object.fromEntries(roles.map((r) => [r.role ?? 'none', r.n])),
        reservesLeft,
        unitsLeft,
        fields: [
          ...new Set(units.flatMap((u) => Object.keys(this.casesService.pii.read(u)))),
        ].sort(),
      };
    });
  }

  /** Saves the plan; once selected only quotas and substitution rules can change. */
  save(ctx: AuthContext, projectId: string, body: SamplingPlanInput, questionnaireId?: string) {
    for (const rule of [body.eligibility, body.exclusions, ...body.quotas.map((q) => q.when)]) {
      const err = rule?.trim() ? ruleError(rule) : null;
      if (err) throw new BadRequestException({ code: 'BAD_RULE', message: err });
    }
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.casesService.project(t, projectId);
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const current = await this.plan(t, projectId, q);
      if (current?.status === 'selected') {
        await t.updatePlan(current.id, {
          quotas: body.quotas,
          substitution: body.substitution,
          // Later units (batches, additions) are checked with the current rules.
          crossChecks: body.crossChecks,
          updatedBy: ctx.userId,
        });
      } else if (current) {
        await t.updatePlan(current.id, { ...body, updatedBy: ctx.userId });
      } else {
        await t.insertPlan({
          projectId,
          questionnaireId: q,
          body,
          seed: randomToken(8),
          userId: ctx.userId,
        });
      }
      return { ok: true };
    });
  }

  /** Runs the selection without keeping it: sizes, per stratum, π range and warnings. */
  preview(tenantId: string, projectId: string, questionnaireId?: string) {
    return this.repo.inTenant(tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q);
      const input = this.input(plan);
      const run = await this.run(t, projectId, q, input, plan?.seed ?? 'preview');
      return run.summary;
    });
  }

  private async run(
    t: SampleTx,
    projectId: string,
    q: Q,
    input: SamplingPlanInput,
    seed: string,
    batch?: { units: Unit[]; count: number },
  ) {
    const units = batch?.units ?? (await this.units(t, projectId, q));
    const screened = this.screen(input, units, await this.checker(t, projectId, input));
    const stats = this.stats(input, screened);
    const sizes = planSizes(input, stats.eligible || undefined);
    const errors = batch ? [] : planChecks(input, stats).filter((c) => c.severity === 'error');
    const design = planDesign(
      input,
      batch ? Math.min(batch.count, stats.eligible) : sizes.selected,
    );
    // Known probabilities: a probability design, or a census (every unit, π = 1).
    const probability = input.design.family === 'probability' || input.design.family === 'census';
    const result =
      input.source.kind === 'field' || !stats.eligible
        ? { main: [], reserve: [], strata: [], warnings: [] }
        : selectSample(this.frameUnitsFor(input, screened), design, {
            seed,
            reserve: input.design.family === 'probability' && !batch ? input.size.reserve : 0,
          });
    const probs = result.main.map((m) => m.prob);
    return {
      screened,
      result,
      errors,
      probability,
      summary: {
        errors,
        sizes,
        selected: result.main.length,
        reserves: result.reserve.length,
        strata: result.strata,
        warnings: result.warnings,
        prob:
          probability && probs.length ? { min: Math.min(...probs), max: Math.max(...probs) } : null,
      },
    };
  }

  /**
   * Selects the sample and makes its cases: main units become cases at once, reserves wait in
   * release order. Probabilities and base weights go on units and cases (decision 5).
   */
  select(ctx: AuthContext, projectId: string, questionnaireId?: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q, true);
      if (!plan) throw new NotFoundException('Save the plan first');
      if (plan.status === 'selected')
        throw new ConflictException({ code: 'SAMPLE_SELECTED', message: 'Already selected' });
      const input = this.input(plan);
      const run = await this.run(t, projectId, q, input, plan.seed);
      if (run.errors.length)
        throw new ConflictException({
          code: 'PLAN_NOT_READY',
          message: run.errors.map((e) => e.code).join(', '),
          checks: run.errors,
        });
      if (input.source.kind === 'field')
        throw new ConflictException({
          code: 'FIELD_SOURCE',
          message: 'Units are captured in the field: create field cases instead',
        });
      // Screening is recorded on every unit.
      await t.markUnits(
        run.screened
          .filter((s) => s.out)
          .map((s) => ({ id: s.unit.id, eligible: s.out !== 'ineligible', exclusion: s.out! })),
      );
      const byId = new Map(run.screened.map((s) => [s.unit.id, s.unit]));
      const prob = (p: number) => (run.probability ? p : null);
      for (const r of run.result.reserve)
        await t.setReserve(r.id, {
          releaseOrder: r.order,
          prob: prob(r.prob),
          weight: run.probability ? baseWeight(r.prob) : null,
          stratum: r.stratum,
        });
      const created = await this.makeCases(
        t,
        ctx,
        projectId,
        q,
        run.result.main.map((m) => ({
          unit: byId.get(m.id)!,
          role: 'main',
          prob: prob(m.prob),
          stratum: m.stratum,
        })),
      );
      const result = { ...run.summary, created: created.length };
      await t.updatePlan(plan.id, { result, selectedBy: ctx.userId });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'sampling.selected',
          targetType: 'project',
          targetId: projectId,
          details: {
            questionnaireId: q,
            design: input.design.method,
            selected: run.result.main.length,
            reserves: run.result.reserve.length,
            seed: plan.seed,
          },
        }),
      );
      return result;
    });
  }

  /**
   * Units imported after a census or non-probability sample was selected: the eligible ones
   * become cases at once ("main", probability 1 in a census, none otherwise); the rest stay in
   * the frame with the reason.
   */
  async addUnits(t: SampleTx, ctx: AuthContext, projectId: string, q: Q, unitIds: string[]) {
    if (!unitIds.length) return 0;
    const input = this.input(await this.plan(t, projectId, q));
    const units = await t.unitsByIds(unitIds);
    const screened = this.screen(input, units, await this.checker(t, projectId, input));
    await t.markUnits(
      screened
        .filter((s) => s.out)
        .map((s) => ({ id: s.unit.id, eligible: s.out !== 'ineligible', exclusion: s.out! })),
    );
    const census = input.design.family === 'census';
    const created = await this.makeCases(
      t,
      ctx,
      projectId,
      q,
      screened
        .filter((s) => !s.out)
        .map((s) => ({
          unit: s.unit,
          role: 'main' as const,
          prob: census ? 1 : null,
          stratum: input.design.strataVar ? String(s.sample[input.design.strataVar] ?? '') : null,
        })),
    );
    return created.length;
  }

  /** Cases from frame units, with their contacts, role, probability and base weight. */
  private async makeCases(
    t: SampleTx,
    ctx: AuthContext,
    projectId: string,
    q: Q,
    rows: {
      unit: Unit;
      role: 'main' | 'reserve' | 'substitute';
      prob: number | null;
      stratum: string | null;
      substituteFor?: string;
    }[],
  ) {
    const pii = await this.casesService.piiFields(t, projectId);
    const created: string[] = [];
    for (const part of chunks(rows)) {
      if (!part.length) continue;
      const ins = await t.insertCases(
        projectId,
        part.map((r) => ({
          externalId: r.unit.externalId,
          questionnaireId: q,
          ...this.casesService.pii.seal(this.casesService.pii.read(r.unit), pii),
          importId: r.unit.importId,
          frameUnitId: r.unit.id,
          selectionRole: r.role,
          substituteFor: r.substituteFor ?? null,
          inclusionProb: r.prob,
          baseWeight: r.prob ? baseWeight(r.prob) : null,
        })),
      );
      const byUnit = new Map(ins.map((x) => [x.frameUnitId!, x.id]));
      await t.insertContacts(
        part.flatMap((r) =>
          byUnit.has(r.unit.id)
            ? r.unit.contacts.map((c) => ({
                caseId: byUnit.get(r.unit.id)!,
                type: c.type,
                value: c.value,
                label: c.label,
              }))
            : [],
        ),
      );
      for (const r of part) {
        const caseId = byUnit.get(r.unit.id);
        if (!caseId) continue;
        await t.linkUnit(r.unit.id, {
          role: r.role === 'substitute' ? 'reserve' : r.role,
          caseId,
          released: r.role !== 'main',
          prob: r.prob,
          weight: r.prob ? baseWeight(r.prob) : null,
          stratum: r.stratum,
        });
      }
      await this.casesService.events(
        t,
        ctx.tenantId,
        ctx.userId,
        part
          .filter((r) => byUnit.has(r.unit.id))
          .map((r) => ({
            caseId: byUnit.get(r.unit.id)!,
            type: 'selected',
            details: {
              role: r.role,
              probability: r.prob,
              stratum: r.stratum,
              ...(r.substituteFor ? { substituteFor: r.substituteFor } : {}),
            },
          })),
      );
      created.push(...ins.map((x) => x.id));
    }
    const pool = (await this.casesService.settings(t, projectId)).assignmentMode === 'pool';
    if (created.length && !pool)
      await this.casesService.applyRules(t, ctx, projectId, {
        onlyCaseIds: created,
        questionnaireId: q,
      });
    return created;
  }

  /**
   * Adds a batch to a selected probability sample: units never selected (not reserves, no
   * case) go through the same design, and the chosen ones become cases next to the existing
   * ones; nothing is replaced. Probabilities are recomputed per stratum as (cases) / N.
   */
  batch(
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof BatchBody>,
    questionnaireId?: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q, true);
      if (plan?.status !== 'selected')
        throw new ConflictException({ code: 'NOT_SELECTED', message: 'Select the sample first' });
      const input = this.input(plan);
      if (input.design.family !== 'probability' || !BATCH_METHODS.includes(input.design.method))
        throw new ConflictException({
          code: 'BATCH_DESIGN',
          message: 'Batches are for simple, systematic and stratified samples; use reserves',
        });
      const free = (await this.units(t, projectId, q)).filter((u) => !u.role && !u.caseId);
      const previous = ((plan.result as { batches?: unknown[] } | null)?.batches ?? []) as {
        n: number;
      }[];
      const n = previous.length + 2;
      const run = await this.run(t, projectId, q, input, `${plan.seed}:batch${n}`, {
        units: free,
        count: body.count,
      });
      if (!run.result.main.length)
        throw new ConflictException({ code: 'NO_UNITS', message: 'No eligible units left' });
      await t.markUnits(
        run.screened
          .filter((s) => s.out)
          .map((s) => ({ id: s.unit.id, eligible: s.out !== 'ineligible', exclusion: s.out! })),
      );
      const byId = new Map(run.screened.map((s) => [s.unit.id, s.unit]));
      const created = await this.makeCases(
        t,
        ctx,
        projectId,
        q,
        run.result.main.map((m) => ({
          unit: byId.get(m.id)!,
          role: 'main' as const,
          prob: m.prob,
          stratum: m.stratum,
        })),
      );
      await this.reweigh(t, projectId, q, input, [
        ...new Set(run.result.main.map((m) => m.stratum)),
      ]);
      const entry = {
        n,
        count: created.length,
        at: new Date().toISOString(),
        by: ctx.userId,
        reason: body.reason,
      };
      await t.updatePlan(plan.id, {
        result: {
          ...((plan.result as Record<string, unknown> | null) ?? {}),
          batches: [...previous, entry],
        },
      });
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'sampling.batch_added',
          targetType: 'project',
          targetId: projectId,
          details: { questionnaireId: q, ...entry },
        }),
      );
      return { added: created.length, batch: n, left: free.length - created.length };
    });
  }

  /**
   * Releases the next reserves (in order, optionally of one stratum), by decision and with a
   * reason. For equal-probability designs the stratum's probabilities are updated to
   * (selected + released) / N, on units and cases.
   */
  release(
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof ReleaseBody>,
    questionnaireId?: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q);
      if (plan?.status !== 'selected')
        throw new ConflictException({ code: 'NOT_SELECTED', message: 'Select the sample first' });
      const next = await t.reserves(projectId, q, {
        limit: body.count,
        ...(body.stratum !== undefined && body.stratum !== null
          ? { stratum: { value: body.stratum } }
          : {}),
      });
      if (!next.length)
        throw new ConflictException({ code: 'NO_RESERVES', message: 'No reserves left' });
      const created = await this.makeCases(
        t,
        ctx,
        projectId,
        q,
        next.map((u) => ({ unit: u, role: 'reserve', prob: u.inclusionProb, stratum: u.stratum })),
      );
      await this.reweigh(t, projectId, q, this.input(plan), [
        ...new Set(next.map((u) => u.stratum)),
      ]);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'sampling.reserves_released',
          targetType: 'project',
          targetId: projectId,
          details: { count: created.length, stratum: body.stratum ?? null, reason: body.reason },
        }),
      );
      return { released: created.length };
    });
  }

  /** Equal-probability designs: π of a stratum = units with a case / eligible units in it. */
  private async reweigh(
    t: SampleTx,
    projectId: string,
    q: Q,
    input: SamplingPlanInput,
    strata: (string | null)[],
  ) {
    const m = input.design.method;
    if (input.design.family !== 'probability' || !['srs', 'systematic', 'stratified'].includes(m))
      return;
    const checker = await this.checker(t, projectId, input);
    // N of each stratum: eligible units of the frame in it (stratum is set at selection on
    // selected units only, so for N the frame is read by the stratum variable). The frame is
    // read and screened once, then counted per stratum.
    const screened = this.screen(input, await this.units(t, projectId, q), checker).filter(
      (s) => !s.out,
    );
    const sizes = new Map<string, number>();
    for (const s of screened) {
      const k = m === 'stratified' ? String(s.sample[input.design.strataVar] ?? '') : '';
      sizes.set(k, (sizes.get(k) ?? 0) + 1);
    }
    for (const stratum of strata) {
      const inStratum = await t.stratumUnits(
        projectId,
        q,
        m === 'stratified' ? { value: stratum } : null,
      );
      const N = sizes.get(m === 'stratified' ? (stratum ?? '') : '') ?? 0;
      const taken = inStratum.filter((u) => u.caseId);
      if (!N || !taken.length) continue;
      const p = taken.length / N;
      await t.reweigh(
        projectId,
        taken.map((u) => u.id),
        p,
        baseWeight(p),
      );
    }
  }

  /**
   * A substitute for a case whose final result the plan allows, taken by the plan's rule (the
   * next reserve of the same stratum, or the next reserve). The original keeps its result.
   */
  substitute(ctx: AuthContext, projectId: string, caseId: string, reason: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const original = await t.lockCase(projectId, caseId);
      if (!original) throw new NotFoundException('Case not found');
      // The substitute comes from the plan of the case's own questionnaire.
      const q = original.questionnaireId;
      const plan = await this.plan(t, projectId, q);
      const input = this.input(plan);
      if (plan?.status !== 'selected' || !input.substitution.allowed)
        throw new ConflictException({
          code: 'SUBSTITUTION_OFF',
          message: 'The plan does not allow substitutes',
        });
      if (!original.disposition || !input.substitution.reasons.includes(original.disposition))
        throw new ConflictException({
          code: 'NOT_SUBSTITUTABLE',
          message: 'Only cases closed with a result the plan lists can be substituted',
        });
      if (await t.hasSubstitute(projectId, caseId))
        throw new ConflictException({ code: 'ALREADY_SUBSTITUTED', message: 'Done' });
      const unit = original.frameUnitId ? await t.unit(original.frameUnitId) : null;
      const [next] = await t.reserves(projectId, q, {
        limit: 1,
        ...(input.substitution.rule === 'sameStratum' && unit
          ? { stratum: { value: unit.stratum } }
          : {}),
      });
      if (!next)
        throw new ConflictException({ code: 'NO_RESERVES', message: 'No reserve fits the rule' });
      const [created] = await this.makeCases(t, ctx, projectId, q, [
        {
          unit: next,
          role: 'substitute',
          prob: next.inclusionProb,
          stratum: next.stratum,
          substituteFor: caseId,
        },
      ]);
      await this.casesService.events(t, ctx.tenantId, ctx.userId, [
        { caseId, type: 'substituted', details: { by: created, reason } },
      ]);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'sampling.substituted',
          targetType: 'case',
          targetId: caseId,
          details: { substitute: created, reason },
        }),
      );
      return { substitute: created };
    });
  }

  /** Cases captured in the field (no frame): numbered slots, optionally for a time-place cell. */
  fieldCases(
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof FieldCasesBody>,
    questionnaireId?: string,
  ) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q);
      const input = this.input(plan);
      if (input.design.family === 'probability' && input.source.kind !== 'field')
        throw new ConflictException({
          code: 'NOT_FIELD',
          message: 'Field cases are for captured units, not probability samples from a frame',
        });
      const existing = await t.caseExternalIds(projectId, q);
      const ids: string[] = [];
      for (let i = 1; ids.length < body.count && i < body.count + existing.size + 10_000; i++) {
        const id = `${body.prefix}-${String(i).padStart(4, '0')}`;
        if (!existing.has(id)) ids.push(id);
      }
      const created = (
        await t.insertCases(
          projectId,
          ids.map((externalId) => ({
            externalId,
            questionnaireId: q,
            sample: body.cell ? { cell: body.cell } : {},
            samplePii: null,
            selectionRole: 'field',
          })),
        )
      ).map((x) => x.id);
      await this.casesService.events(
        t,
        ctx.tenantId,
        ctx.userId,
        created.map((caseId) => ({
          caseId,
          type: 'field_slot',
          details: { cell: body.cell ?? null },
        })),
      );
      const pool = (await this.casesService.settings(t, projectId)).assignmentMode === 'pool';
      if (created.length && !pool)
        await this.casesService.applyRules(t, ctx, projectId, {
          onlyCaseIds: created,
          questionnaireId: q,
        });
      return { created: created.length };
    });
  }

  /** Empties the frame before anything is selected (to load a corrected list). */
  clearFrame(ctx: AuthContext, projectId: string, questionnaireId?: string) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const q = await this.casesService.questionnaireFor(t, projectId, questionnaireId);
      const plan = await this.plan(t, projectId, q);
      if (plan?.status === 'selected')
        throw new ConflictException({ code: 'SAMPLE_SELECTED', message: 'Already selected' });
      return { removed: await t.clearFrame(projectId, q) };
    });
  }
}
