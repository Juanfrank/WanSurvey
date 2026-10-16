import {
  BadRequestException,
  ConflictException,
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
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { randomToken } from '../common/crypto.js';
import { Database, type Tx } from '../db/database.js';
import { cases, contacts, frameUnits, samplingPlans } from '../db/schema.js';
import { compileRule, ruleError } from '../cases/case-logic.js';
import { chunks, CasesService } from '../cases/cases.service.js';

export const ReleaseBody = z.object({
  count: z.number().int().min(1).max(10_000),
  stratum: z.string().max(200).nullable().optional(),
  reason: z.string().trim().min(1).max(500),
});
export const SubstituteBody = z.object({ reason: z.string().trim().min(1).max(500) });
export const FieldCasesBody = z.object({
  count: z.number().int().min(1).max(5000),
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/),
  /** Where and when they are taken (time-location designs), kept in the case data. */
  cell: z.string().trim().max(200).optional(),
});

type Plan = typeof samplingPlans.$inferSelect;
type Unit = typeof frameUnits.$inferSelect;

/**
 * The sampling selector (S1): the frame of units, the plan, the selection with its
 * probabilities of inclusion, reserves released by decision, and substitutes by rule. Units and
 * cases of a selected sample are never deleted or silently replaced (decision 6).
 */
@Injectable()
export class SamplingService {
  constructor(
    private readonly database: Database,
    private readonly casesService: CasesService,
    private readonly audit: AuditService,
  ) {}

  private input(plan: Plan | undefined): SamplingPlanInput {
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
          }
        : {},
    );
  }

  private async plan(tx: Tx, projectId: string) {
    const [p] = await tx.select().from(samplingPlans).where(eq(samplingPlans.projectId, projectId));
    return p;
  }

  private async units(tx: Tx, projectId: string) {
    return tx
      .select()
      .from(frameUnits)
      .where(eq(frameUnits.projectId, projectId))
      .orderBy(asc(frameUnits.externalId));
  }

  /** Eligibility and exclusions applied to the frame (units keep a reason when out). */
  private screen(input: SamplingPlanInput, units: Unit[]) {
    const eligible = compileRule(input.eligibility);
    const excluded = input.exclusions?.trim() ? compileRule(input.exclusions) : () => false;
    return units.map((u) => {
      const c = {
        sample: this.casesService.pii.read(u),
        status: 'fresh',
        priority: 0,
        modePreference: null,
      };
      const why = !eligible(c) ? 'ineligible' : excluded(c) ? 'excluded' : null;
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
  get(tenantId: string, projectId: string) {
    return this.database.withTenant(tenantId, async (tx) => {
      const plan = await this.plan(tx, projectId);
      const input = this.input(plan);
      const units = await this.units(tx, projectId);
      const screened = this.screen(input, units);
      const stats = this.stats(input, screened);
      const roles = await tx
        .select({ role: cases.selectionRole, n: sql<number>`count(*)::int` })
        .from(cases)
        .where(eq(cases.projectId, projectId))
        .groupBy(cases.selectionRole);
      const reservesLeft = units.filter((u) => u.role === 'reserve' && !u.caseId).length;
      const sources = [...new Set(units.map((u) => u.sourceLabel ?? ''))].map((label) => ({
        label,
        units: units.filter((u) => (u.sourceLabel ?? '') === label).length,
      }));
      return {
        plan: input,
        status: plan?.status ?? 'draft',
        seed: plan?.seed ?? null,
        selectedAt: plan?.selectedAt ?? null,
        result: plan?.result ?? null,
        sizes: planSizes(input, stats.eligible || undefined),
        checks: planChecks(input, stats),
        frame: { ...stats, sources },
        cases: Object.fromEntries(roles.map((r) => [r.role ?? 'none', r.n])),
        reservesLeft,
        fields: [
          ...new Set(units.flatMap((u) => Object.keys(this.casesService.pii.read(u)))),
        ].sort(),
      };
    });
  }

  /** Saves the plan; once selected only quotas and substitution rules can change. */
  save(ctx: AuthContext, projectId: string, body: SamplingPlanInput) {
    for (const rule of [body.eligibility, body.exclusions, ...body.quotas.map((q) => q.when)]) {
      const err = rule?.trim() ? ruleError(rule) : null;
      if (err) throw new BadRequestException({ code: 'BAD_RULE', message: err });
    }
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.casesService.project(tx, projectId);
      const current = await this.plan(tx, projectId);
      if (current?.status === 'selected') {
        await tx
          .update(samplingPlans)
          .set({
            quotas: body.quotas,
            substitution: body.substitution,
            updatedAt: new Date(),
            updatedBy: ctx.userId,
          })
          .where(eq(samplingPlans.id, current.id));
      } else if (current) {
        await tx
          .update(samplingPlans)
          .set({ ...body, updatedAt: new Date(), updatedBy: ctx.userId })
          .where(eq(samplingPlans.id, current.id));
      } else {
        await tx.insert(samplingPlans).values({
          tenantId: ctx.tenantId,
          projectId,
          ...body,
          seed: randomToken(8),
          updatedBy: ctx.userId,
        });
      }
      return { ok: true };
    });
  }

  /** Runs the selection without keeping it: sizes, per stratum, π range and warnings. */
  preview(tenantId: string, projectId: string) {
    return this.database.withTenant(tenantId, async (tx) => {
      const plan = await this.plan(tx, projectId);
      const input = this.input(plan);
      const run = await this.run(tx, projectId, input, plan?.seed ?? 'preview');
      return run.summary;
    });
  }

  private async run(tx: Tx, projectId: string, input: SamplingPlanInput, seed: string) {
    const units = await this.units(tx, projectId);
    const screened = this.screen(input, units);
    const stats = this.stats(input, screened);
    const sizes = planSizes(input, stats.eligible || undefined);
    const errors = planChecks(input, stats).filter((c) => c.severity === 'error');
    const design = planDesign(input, sizes.selected);
    // Known probabilities: a probability design, or a census (every unit, π = 1).
    const probability = input.design.family === 'probability' || input.design.family === 'census';
    const result =
      input.source.kind === 'field' || !stats.eligible
        ? { main: [], reserve: [], strata: [], warnings: [] }
        : selectSample(this.frameUnitsFor(input, screened), design, {
            seed,
            reserve: input.design.family === 'probability' ? input.size.reserve : 0,
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
  select(ctx: AuthContext, projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const [plan] = await tx
        .select()
        .from(samplingPlans)
        .where(eq(samplingPlans.projectId, projectId))
        .for('update');
      if (!plan) throw new NotFoundException('Save the plan first');
      if (plan.status === 'selected')
        throw new ConflictException({ code: 'SAMPLE_SELECTED', message: 'Already selected' });
      const input = this.input(plan);
      const run = await this.run(tx, projectId, input, plan.seed);
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
      for (const s of run.screened)
        if (s.out)
          await tx
            .update(frameUnits)
            .set({ eligible: s.out !== 'ineligible', exclusion: s.out })
            .where(eq(frameUnits.id, s.unit.id));
      const byId = new Map(run.screened.map((s) => [s.unit.id, s.unit]));
      const prob = (p: number) => (run.probability ? p : null);
      for (const r of run.result.reserve)
        await tx
          .update(frameUnits)
          .set({
            role: 'reserve',
            releaseOrder: r.order,
            inclusionProb: prob(r.prob),
            baseWeight: run.probability ? baseWeight(r.prob) : null,
            stratum: r.stratum,
          })
          .where(eq(frameUnits.id, r.id));
      const created = await this.makeCases(
        tx,
        ctx,
        projectId,
        run.result.main.map((m) => ({
          unit: byId.get(m.id)!,
          role: 'main',
          prob: prob(m.prob),
          stratum: m.stratum,
        })),
      );
      const result = { ...run.summary, created: created.length };
      await tx
        .update(samplingPlans)
        .set({ status: 'selected', selectedAt: new Date(), selectedBy: ctx.userId, result })
        .where(eq(samplingPlans.id, plan.id));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'sampling.selected',
          targetType: 'project',
          targetId: projectId,
          details: {
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
  async addUnits(tx: Tx, ctx: AuthContext, projectId: string, unitIds: string[]) {
    if (!unitIds.length) return 0;
    const input = this.input(await this.plan(tx, projectId));
    const units = await tx.select().from(frameUnits).where(inArray(frameUnits.id, unitIds));
    const screened = this.screen(input, units);
    for (const s of screened)
      if (s.out)
        await tx
          .update(frameUnits)
          .set({ eligible: s.out !== 'ineligible', exclusion: s.out })
          .where(eq(frameUnits.id, s.unit.id));
    const census = input.design.family === 'census';
    const created = await this.makeCases(
      tx,
      ctx,
      projectId,
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
    tx: Tx,
    ctx: AuthContext,
    projectId: string,
    rows: {
      unit: Unit;
      role: 'main' | 'reserve' | 'substitute';
      prob: number | null;
      stratum: string | null;
      substituteFor?: string;
    }[],
  ) {
    const pii = await this.casesService.piiFields(tx, projectId);
    const created: string[] = [];
    for (const part of chunks(rows)) {
      if (!part.length) continue;
      const ins = await tx
        .insert(cases)
        .values(
          part.map((r) => ({
            tenantId: ctx.tenantId,
            projectId,
            externalId: r.unit.externalId,
            ...this.casesService.pii.seal(this.casesService.pii.read(r.unit), pii),
            importId: r.unit.importId,
            frameUnitId: r.unit.id,
            selectionRole: r.role,
            substituteFor: r.substituteFor ?? null,
            inclusionProb: r.prob,
            baseWeight: r.prob ? baseWeight(r.prob) : null,
          })),
        )
        .onConflictDoNothing({ target: [cases.projectId, cases.externalId] })
        .returning({ id: cases.id, externalId: cases.externalId, frameUnitId: cases.frameUnitId });
      const byUnit = new Map(ins.map((x) => [x.frameUnitId!, x.id]));
      const contactRows = part.flatMap((r) =>
        byUnit.has(r.unit.id)
          ? (r.unit.contacts as { type: string; value: string; label: string | null }[]).map(
              (c) => ({
                tenantId: ctx.tenantId,
                caseId: byUnit.get(r.unit.id)!,
                type: c.type,
                value: c.value,
                label: c.label,
              }),
            )
          : [],
      );
      for (const c of chunks(contactRows)) if (c.length) await tx.insert(contacts).values(c);
      for (const r of part) {
        const caseId = byUnit.get(r.unit.id);
        if (!caseId) continue;
        await tx
          .update(frameUnits)
          .set({
            role: r.role === 'substitute' ? 'reserve' : r.role,
            caseId,
            releasedAt: r.role === 'main' ? null : new Date(),
            inclusionProb: r.prob,
            baseWeight: r.prob ? baseWeight(r.prob) : null,
            stratum: r.stratum,
          })
          .where(eq(frameUnits.id, r.unit.id));
      }
      await this.casesService.events(
        tx,
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
    const pool = (await this.casesService.settings(tx, projectId)).assignmentMode === 'pool';
    if (created.length && !pool)
      await this.casesService.applyRules(tx, ctx, projectId, { onlyCaseIds: created });
    return created;
  }

  /**
   * Releases the next reserves (in order, optionally of one stratum), by decision and with a
   * reason. For equal-probability designs the stratum's probabilities are updated to
   * (selected + released) / N, on units and cases.
   */
  release(ctx: AuthContext, projectId: string, body: z.infer<typeof ReleaseBody>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const plan = await this.plan(tx, projectId);
      if (plan?.status !== 'selected')
        throw new ConflictException({ code: 'NOT_SELECTED', message: 'Select the sample first' });
      const next = await tx
        .select()
        .from(frameUnits)
        .where(
          and(
            eq(frameUnits.projectId, projectId),
            eq(frameUnits.role, 'reserve'),
            isNull(frameUnits.caseId),
            ...(body.stratum !== undefined && body.stratum !== null
              ? [eq(frameUnits.stratum, body.stratum)]
              : []),
          ),
        )
        .orderBy(asc(frameUnits.releaseOrder), asc(frameUnits.externalId))
        .limit(body.count);
      if (!next.length)
        throw new ConflictException({ code: 'NO_RESERVES', message: 'No reserves left' });
      const created = await this.makeCases(
        tx,
        ctx,
        projectId,
        next.map((u) => ({ unit: u, role: 'reserve', prob: u.inclusionProb, stratum: u.stratum })),
      );
      await this.reweigh(tx, projectId, this.input(plan), [...new Set(next.map((u) => u.stratum))]);
      await this.audit.record(
        tx,
        ctx.tenantId,
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
    tx: Tx,
    projectId: string,
    input: SamplingPlanInput,
    strata: (string | null)[],
  ) {
    const m = input.design.method;
    if (input.design.family !== 'probability' || !['srs', 'systematic', 'stratified'].includes(m))
      return;
    for (const stratum of strata) {
      const inStratum = await tx
        .select({
          id: frameUnits.id,
          caseId: frameUnits.caseId,
          eligible: frameUnits.eligible,
          exclusion: frameUnits.exclusion,
        })
        .from(frameUnits)
        .where(
          and(
            eq(frameUnits.projectId, projectId),
            m === 'stratified' && stratum !== null ? eq(frameUnits.stratum, stratum) : sql`true`,
          ),
        );
      // N of the stratum: eligible units of the frame in it (stratum is set at selection on
      // selected units only, so for N the frame is read by the stratum variable).
      const all = await this.units(tx, projectId);
      const screened = this.screen(input, all).filter((s) => !s.out);
      const N =
        m === 'stratified'
          ? screened.filter(
              (s) => String(s.sample[input.design.strataVar] ?? '') === (stratum ?? ''),
            ).length
          : screened.length;
      const taken = inStratum.filter((u) => u.caseId);
      if (!N || !taken.length) continue;
      const p = taken.length / N;
      const ids = taken.map((u) => u.id);
      await tx
        .update(frameUnits)
        .set({ inclusionProb: p, baseWeight: baseWeight(p) })
        .where(inArray(frameUnits.id, ids));
      await tx
        .update(cases)
        .set({ inclusionProb: p, baseWeight: baseWeight(p) })
        .where(and(eq(cases.projectId, projectId), inArray(cases.frameUnitId, ids)));
    }
  }

  /**
   * A substitute for a case whose final result the plan allows, taken by the plan's rule (the
   * next reserve of the same stratum, or the next reserve). The original keeps its result.
   */
  substitute(ctx: AuthContext, projectId: string, caseId: string, reason: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const plan = await this.plan(tx, projectId);
      const input = this.input(plan);
      if (plan?.status !== 'selected' || !input.substitution.allowed)
        throw new ConflictException({
          code: 'SUBSTITUTION_OFF',
          message: 'The plan does not allow substitutes',
        });
      const [original] = await tx
        .select()
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.projectId, projectId)))
        .for('update');
      if (!original) throw new NotFoundException('Case not found');
      if (!original.disposition || !input.substitution.reasons.includes(original.disposition))
        throw new ConflictException({
          code: 'NOT_SUBSTITUTABLE',
          message: 'Only cases closed with a result the plan lists can be substituted',
        });
      const [already] = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.projectId, projectId), eq(cases.substituteFor, caseId)));
      if (already) throw new ConflictException({ code: 'ALREADY_SUBSTITUTED', message: 'Done' });
      const [unit] = original.frameUnitId
        ? await tx.select().from(frameUnits).where(eq(frameUnits.id, original.frameUnitId))
        : [];
      const [next] = await tx
        .select()
        .from(frameUnits)
        .where(
          and(
            eq(frameUnits.projectId, projectId),
            eq(frameUnits.role, 'reserve'),
            isNull(frameUnits.caseId),
            ...(input.substitution.rule === 'sameStratum' && unit
              ? [
                  unit.stratum === null
                    ? isNull(frameUnits.stratum)
                    : eq(frameUnits.stratum, unit.stratum),
                ]
              : []),
          ),
        )
        .orderBy(asc(frameUnits.releaseOrder), asc(frameUnits.externalId))
        .limit(1);
      if (!next)
        throw new ConflictException({ code: 'NO_RESERVES', message: 'No reserve fits the rule' });
      const [created] = await this.makeCases(tx, ctx, projectId, [
        {
          unit: next,
          role: 'substitute',
          prob: next.inclusionProb,
          stratum: next.stratum,
          substituteFor: caseId,
        },
      ]);
      await this.casesService.events(tx, ctx.tenantId, ctx.userId, [
        { caseId, type: 'substituted', details: { by: created, reason } },
      ]);
      await this.audit.record(
        tx,
        ctx.tenantId,
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
  fieldCases(ctx: AuthContext, projectId: string, body: z.infer<typeof FieldCasesBody>) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const plan = await this.plan(tx, projectId);
      const input = this.input(plan);
      if (input.design.family === 'probability' && input.source.kind !== 'field')
        throw new ConflictException({
          code: 'NOT_FIELD',
          message: 'Field cases are for captured units, not probability samples from a frame',
        });
      const existing = new Set(
        (
          await tx
            .select({ externalId: cases.externalId })
            .from(cases)
            .where(eq(cases.projectId, projectId))
        ).map((c) => c.externalId),
      );
      const ids: string[] = [];
      for (let i = 1; ids.length < body.count && i < body.count + existing.size + 10_000; i++) {
        const id = `${body.prefix}-${String(i).padStart(4, '0')}`;
        if (!existing.has(id)) ids.push(id);
      }
      const created: string[] = [];
      for (const part of chunks(ids)) {
        const ins = await tx
          .insert(cases)
          .values(
            part.map((externalId) => ({
              tenantId: ctx.tenantId,
              projectId,
              externalId,
              sample: body.cell ? { cell: body.cell } : {},
              selectionRole: 'field',
            })),
          )
          .returning({ id: cases.id });
        created.push(...ins.map((x) => x.id));
      }
      await this.casesService.events(
        tx,
        ctx.tenantId,
        ctx.userId,
        created.map((caseId) => ({
          caseId,
          type: 'field_slot',
          details: { cell: body.cell ?? null },
        })),
      );
      const pool = (await this.casesService.settings(tx, projectId)).assignmentMode === 'pool';
      if (created.length && !pool)
        await this.casesService.applyRules(tx, ctx, projectId, { onlyCaseIds: created });
      return { created: created.length };
    });
  }

  /** Empties the frame before anything is selected (to load a corrected list). */
  clearFrame(ctx: AuthContext, projectId: string) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const plan = await this.plan(tx, projectId);
      if (plan?.status === 'selected')
        throw new ConflictException({ code: 'SAMPLE_SELECTED', message: 'Already selected' });
      const r = await tx
        .delete(frameUnits)
        .where(eq(frameUnits.projectId, projectId))
        .returning({ id: frameUnits.id });
      return { removed: r.length };
    });
  }
}
