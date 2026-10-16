import type { SamplingPlanInput } from '@wansurvey/schema/sampling';
import { seededRandom } from './hash.js';

// ---------------------------------------------------------------------------
// Sample size: what the objective needs, then what has to be selected and fielded
// ---------------------------------------------------------------------------

/** Inverse of the standard normal distribution (Acklam's rational approximation). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be between 0 and 1');
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** z for a two-sided confidence level (0.95 → 1.96). */
export const zFor = (confidence: number) => normalQuantile(1 - (1 - confidence) / 2);

export type SizeObjective =
  | {
      /** Estimate a proportion within ± margin. */
      kind: 'proportion';
      confidence: number;
      margin: number;
      /** Expected proportion; 0.5 is the safest. */
      p: number;
    }
  | {
      /** Estimate a mean within ± margin, given the standard deviation. */
      kind: 'mean';
      confidence: number;
      margin: number;
      sd: number;
    }
  | {
      /** Detect a difference between two proportions (per group). */
      kind: 'difference';
      confidence: number;
      power: number;
      p1: number;
      p2: number;
    };

export interface SizeInput {
  objective: SizeObjective;
  /** Design effect (1 for simple random sampling; above 1 for clusters). */
  deff: number;
  /** Population size when known: applies the finite population correction. */
  population?: number | null;
}

export interface SizeResult {
  /** Before the design effect and the correction. */
  base: number;
  /** The completed interviews the objective needs. */
  required: number;
  fpcApplied: boolean;
}

/**
 * Completed interviews needed for an objective (Cochran): z²p(1−p)/e² for a proportion,
 * (zσ/e)² for a mean, the usual two-sample formula for a difference; times the design
 * effect, then the finite population correction n/(1+(n−1)/N) when N is known.
 */
export function requiredSize(input: SizeInput): SizeResult {
  const o = input.objective;
  let base: number;
  if (o.kind === 'proportion') {
    const z = zFor(o.confidence);
    base = (z * z * o.p * (1 - o.p)) / (o.margin * o.margin);
  } else if (o.kind === 'mean') {
    const z = zFor(o.confidence);
    base = ((z * o.sd) / o.margin) ** 2;
  } else {
    const za = zFor(o.confidence);
    const zb = normalQuantile(o.power);
    const pbar = (o.p1 + o.p2) / 2;
    const num =
      za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(o.p1 * (1 - o.p1) + o.p2 * (1 - o.p2));
    base = (num * num) / (o.p1 - o.p2) ** 2;
  }
  let n = base * Math.max(1, input.deff);
  const N = input.population ?? null;
  const fpcApplied = !!N && N > 0 && o.kind !== 'difference';
  if (fpcApplied) n = n / (1 + (n - 1) / N!);
  return { base, required: Math.ceil(n - 1e-9), fpcApplied };
}

export interface OperationalInput {
  required: number;
  /** Share of selected units expected to be eligible (0–1]. */
  eligibility: number;
  /** Share of eligible units expected to complete (0–1]. */
  response: number;
  /** Reserve units, as a share of the selected ones. */
  reserve: number;
}

/**
 * The three numbers that differ (decision 2): completes required, units to select so that,
 * after eligibility and non-response, the required completes remain, and cases to manage in
 * the field including reserves.
 */
export function operationalSize(i: OperationalInput) {
  const selected = Math.ceil(
    i.required / (Math.max(0.01, i.eligibility) * Math.max(0.01, i.response)) - 1e-9,
  );
  const reserves = Math.ceil(selected * Math.max(0, i.reserve) - 1e-9);
  return { required: i.required, selected, reserves, cases: selected + reserves };
}

// ---------------------------------------------------------------------------
// Selection from a frame, with inclusion probabilities (decision 5)
// ---------------------------------------------------------------------------

export interface FrameUnit {
  id: string;
  stratum?: string | null;
  cluster?: string | null;
  /** Measure of size for probability proportional to size (households, people…). */
  size?: number | null;
  /** Order for systematic selection (implicit stratification). */
  sortKey?: string | number | null;
}

export type SelectionDesign =
  | { method: 'census' }
  | { method: 'srs'; n: number }
  | { method: 'systematic'; n: number }
  | {
      method: 'stratified';
      n: number;
      allocation: 'proportional' | 'equal' | 'manual';
      /** For manual allocation: units per stratum. */
      perStratum?: Record<string, number>;
      within: 'srs' | 'systematic';
    }
  | {
      /** One stage (take all units) or two (a fixed number per selected cluster). */
      method: 'cluster';
      clusters: number;
      pps: boolean;
      perCluster?: number | null;
    }
  | {
      /** Strata, then clusters (PPS) within each stratum, then units within clusters. */
      method: 'multistage';
      clustersPerStratum: number;
      perCluster: number;
    };

export interface Selected {
  id: string;
  /** Probability of inclusion of the unit under the design. */
  prob: number;
  stratum: string | null;
  /** Release order of reserves (1 first); 0 for main units. */
  order: number;
}

export interface SelectionResult {
  main: Selected[];
  reserve: Selected[];
  /** Units and selections per stratum (or "" without strata). */
  strata: { stratum: string; population: number; selected: number; reserve: number }[];
  warnings: string[];
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Splits n over strata: proportional (largest remainders), equal, or as given. */
export function allocate(
  sizes: Record<string, number>,
  n: number,
  how: 'proportional' | 'equal' | 'manual',
  manual: Record<string, number> = {},
): Record<string, number> {
  const keys = Object.keys(sizes).sort();
  const N = keys.reduce((s, k) => s + sizes[k]!, 0);
  const out: Record<string, number> = {};
  if (how === 'manual') {
    for (const k of keys) out[k] = Math.min(sizes[k]!, Math.max(0, Math.floor(manual[k] ?? 0)));
    return out;
  }
  if (how === 'equal') {
    const each = Math.floor(n / keys.length);
    let left = n - each * keys.length;
    for (const k of keys) {
      out[k] = Math.min(sizes[k]!, each + (left > 0 ? 1 : 0));
      if (left > 0) left--;
    }
    return out;
  }
  const exact = keys.map((k) => ({ k, x: N ? (n * sizes[k]!) / N : 0 }));
  for (const e of exact) out[e.k] = Math.min(sizes[e.k]!, Math.floor(e.x));
  let left = n - keys.reduce((s, k) => s + out[k]!, 0);
  for (const e of [...exact].sort((a, b) => (b.x % 1) - (a.x % 1))) {
    if (left <= 0) break;
    if (out[e.k]! < sizes[e.k]!) {
      out[e.k]!++;
      left--;
    }
  }
  return out;
}

/** Systematic selection of n from a list (fractional interval, random start). */
function systematic<T>(list: T[], n: number, rnd: () => number): T[] {
  if (n <= 0) return [];
  if (n >= list.length) return [...list];
  const k = list.length / n;
  const start = rnd() * k;
  return Array.from({ length: n }, (_, i) => list[Math.floor(start + i * k)]!);
}

/** Systematic PPS selection of m clusters by size; returns the clusters and their π. */
function ppsClusters(
  clusters: { key: string; size: number }[],
  m: number,
  rnd: () => number,
): { key: string; prob: number }[] {
  const total = clusters.reduce((s, c) => s + c.size, 0);
  if (!total || m <= 0) return [];
  // Clusters larger than the interval are taken with certainty.
  const certain = clusters.filter((c) => (m * c.size) / total >= 1);
  const rest = clusters.filter((c) => (m * c.size) / total < 1);
  const left = m - certain.length;
  const restTotal = rest.reduce((s, c) => s + c.size, 0);
  const out = certain.map((c) => ({ key: c.key, prob: 1 }));
  if (left > 0 && restTotal > 0) {
    const k = restTotal / left;
    let point = rnd() * k;
    let acc = 0;
    for (const c of rest) {
      acc += c.size;
      if (point < acc) {
        out.push({ key: c.key, prob: Math.min(1, (left * c.size) / restTotal) });
        point += k;
      }
    }
  }
  return out;
}

const sortUnits = (a: FrameUnit, b: FrameUnit) =>
  String(a.sortKey ?? '').localeCompare(String(b.sortKey ?? ''), undefined, { numeric: true }) ||
  a.id.localeCompare(b.id);

/**
 * Selects units from the eligible frame with a seeded random source, so the same seed gives the
 * same sample. Every unit carries its probability of inclusion; reserves (`reserve` as a share
 * of the main selection) are drawn from the same strata and kept in release order.
 */
export function selectSample(
  units: FrameUnit[],
  design: SelectionDesign,
  opts: { seed: string; reserve?: number },
): SelectionResult {
  const rnd = seededRandom(opts.seed);
  const warnings: string[] = [];
  const reserveShare = Math.max(0, opts.reserve ?? 0);
  const main: Selected[] = [];
  const reserve: Selected[] = [];
  const byStratum = new Map<string, FrameUnit[]>();
  for (const u of units) {
    const k = u.stratum ?? '';
    byStratum.set(k, [...(byStratum.get(k) ?? []), u]);
  }
  const strataOut = new Map<string, { population: number; selected: number; reserve: number }>(
    [...byStratum].map(([k, v]) => [k, { population: v.length, selected: 0, reserve: 0 }]),
  );

  /** SRS or systematic of n from a stratum, plus reserves from what is left. */
  const fromList = (list: FrameUnit[], n: number, how: 'srs' | 'systematic', stratum: string) => {
    const N = list.length;
    const take = Math.min(n, N);
    if (n > N) warnings.push(`stratum_too_small:${stratum || '-'}:${N}:${n}`);
    const picked =
      how === 'systematic'
        ? systematic([...list].sort(sortUnits), take, rnd)
        : shuffle(list, rnd).slice(0, take);
    const pickedIds = new Set(picked.map((u) => u.id));
    const prob = N ? take / N : 0;
    for (const u of picked) main.push({ id: u.id, prob, stratum: stratum || null, order: 0 });
    const r = Math.min(N - take, Math.ceil(take * reserveShare - 1e-9));
    const spare = shuffle(
      list.filter((u) => !pickedIds.has(u.id)),
      rnd,
    ).slice(0, r);
    spare.forEach((u, i) =>
      reserve.push({ id: u.id, prob, stratum: stratum || null, order: i + 1 }),
    );
    const s = strataOut.get(stratum)!;
    s.selected += take;
    s.reserve += spare.length;
    if (take === 1) warnings.push(`single_unit_stratum:${stratum || '-'}`);
  };

  /** Clusters (SRS or PPS), all units or a fixed number per cluster. */
  const fromClusters = (
    list: FrameUnit[],
    m: number,
    pps: boolean,
    perCluster: number | null | undefined,
    stratum: string,
  ) => {
    const groups = new Map<string, FrameUnit[]>();
    for (const u of list) {
      const c = u.cluster ?? '';
      groups.set(c, [...(groups.get(c) ?? []), u]);
    }
    if (groups.has('')) warnings.push(`units_without_cluster:${groups.get('')!.length}`);
    const clusters = [...groups.keys()].sort().map((key) => ({
      key,
      size: pps ? groups.get(key)!.reduce((s, u) => s + (u.size ?? 1), 0) : groups.get(key)!.length,
    }));
    const M = clusters.length;
    if (m > M) warnings.push(`too_few_clusters:${stratum || '-'}:${M}:${m}`);
    const chosen = pps
      ? ppsClusters(clusters, Math.min(m, M), rnd)
      : shuffle(clusters, rnd)
          .slice(0, Math.min(m, M))
          .map((c) => ({ key: c.key, prob: M ? Math.min(m, M) / M : 0 }));
    const s = strataOut.get(stratum)!;
    for (const c of chosen) {
      const members = groups.get(c.key)!;
      const take = perCluster ? Math.min(perCluster, members.length) : members.length;
      const within = members.length ? take / members.length : 0;
      const picked = shuffle(members, rnd).slice(0, take);
      for (const u of picked)
        main.push({ id: u.id, prob: c.prob * within, stratum: stratum || null, order: 0 });
      s.selected += picked.length;
      // Reserves within the same cluster (second stage only).
      if (perCluster) {
        const spare = members
          .filter((u) => !picked.includes(u))
          .slice(0, Math.ceil(take * reserveShare - 1e-9));
        spare.forEach((u, i) =>
          reserve.push({ id: u.id, prob: c.prob * within, stratum: stratum || null, order: i + 1 }),
        );
        s.reserve += spare.length;
      }
    }
  };

  switch (design.method) {
    case 'census':
      for (const u of units) main.push({ id: u.id, prob: 1, stratum: u.stratum ?? null, order: 0 });
      for (const [k, v] of byStratum) strataOut.get(k)!.selected = v.length;
      break;
    case 'srs':
      // Without stratification the strata play no part.
      strataOut.clear();
      strataOut.set('', { population: units.length, selected: 0, reserve: 0 });
      fromList(units, design.n, 'srs', '');
      break;
    case 'systematic':
      strataOut.clear();
      strataOut.set('', { population: units.length, selected: 0, reserve: 0 });
      fromList(units, design.n, 'systematic', '');
      break;
    case 'stratified': {
      const sizes = Object.fromEntries([...byStratum].map(([k, v]) => [k, v.length]));
      const n = allocate(sizes, design.n, design.allocation, design.perStratum);
      for (const [k, list] of byStratum) fromList(list, n[k] ?? 0, design.within, k);
      break;
    }
    case 'cluster':
      strataOut.clear();
      strataOut.set('', { population: units.length, selected: 0, reserve: 0 });
      fromClusters(units, design.clusters, design.pps, design.perCluster, '');
      break;
    case 'multistage':
      for (const [k, list] of byStratum)
        fromClusters(list, design.clustersPerStratum, true, design.perCluster, k);
      break;
  }
  // Release order is global among reserves of a stratum; main units keep order 0.
  return {
    main,
    reserve,
    strata: [...strataOut].map(([stratum, v]) => ({ stratum, ...v })),
    warnings,
  };
}

/** Base weight of a unit: the inverse of its probability of inclusion. */
export const baseWeight = (prob: number) => (prob > 0 ? 1 / prob : null);

// ---------------------------------------------------------------------------
// From a plan (S1) to sizes, a selection design and the checks before selecting
// ---------------------------------------------------------------------------

/** Completes required, units to select and cases to field, from the plan's size settings. */
export function planSizes(plan: Pick<SamplingPlanInput, 'size' | 'source'>, frameSize?: number) {
  const s = plan.size;
  const population =
    plan.source.populationKnown && plan.source.populationSize
      ? plan.source.populationSize
      : (frameSize ?? null);
  const need =
    s.objective === 'fixed'
      ? { base: s.fixedN, required: s.fixedN, fpcApplied: false }
      : requiredSize({
          objective:
            s.objective === 'proportion'
              ? { kind: 'proportion', confidence: s.confidence, margin: s.margin, p: s.p }
              : s.objective === 'mean'
                ? { kind: 'mean', confidence: s.confidence, margin: s.margin, sd: s.sd }
                : {
                    kind: 'difference',
                    confidence: s.confidence,
                    power: s.power,
                    p1: s.p1,
                    p2: s.p2,
                  },
          deff: s.deff,
          population: plan.source.populationKnown ? population : null,
        });
  const op = operationalSize({
    required: need.required,
    eligibility: s.eligibility,
    response: s.response,
    reserve: s.reserve,
  });
  return { ...op, base: need.base, fpcApplied: need.fpcApplied, population };
}

/** The selection design for a plan, selecting `n` units. */
export function planDesign(plan: Pick<SamplingPlanInput, 'design'>, n: number): SelectionDesign {
  const d = plan.design;
  if (d.family !== 'probability') return { method: 'census' };
  switch (d.method) {
    case 'systematic':
      return { method: 'systematic', n };
    case 'stratified':
      return {
        method: 'stratified',
        n,
        allocation: d.allocation,
        perStratum: d.perStratum,
        within: d.within,
      };
    case 'cluster':
      return {
        method: 'cluster',
        clusters: d.clusters,
        pps: d.pps,
        perCluster: d.perCluster || null,
      };
    case 'multistage':
      return {
        method: 'multistage',
        clustersPerStratum: d.clusters,
        perCluster: Math.max(1, d.perCluster || 1),
      };
    default:
      return { method: 'srs', n };
  }
}

export interface FrameStats {
  units: number;
  eligible: number;
  excluded: number;
  strata: number;
  smallestStratum: number | null;
  clusters: number;
}

export interface PlanCheck {
  code: string;
  severity: 'error' | 'warning' | 'info';
  params?: Record<string, string | number>;
}

/**
 * Layer 3: what stops the selection, what weakens it, and what can and cannot be said from
 * it (no margin of error for non-probability designs, decision 5).
 */
export function planChecks(plan: SamplingPlanInput, stats: FrameStats): PlanCheck[] {
  const out: PlanCheck[] = [];
  const d = plan.design;
  const sizes = planSizes(plan, stats.eligible || undefined);
  const probability = d.family === 'probability';
  const needsFrame = probability || d.family === 'census';
  if (needsFrame && (!plan.source.frameAvailable || plan.source.kind === 'field'))
    out.push({ code: 'probability_needs_frame', severity: 'error' });
  if (needsFrame && plan.source.frameAvailable && plan.source.kind !== 'field' && !stats.units)
    out.push({ code: 'frame_empty', severity: 'error' });
  if (probability && stats.eligible && sizes.selected > stats.eligible)
    out.push({
      code: 'sample_exceeds_frame',
      severity: 'warning',
      params: { selected: sizes.selected, eligible: stats.eligible },
    });
  if ((d.method === 'stratified' || d.method === 'multistage') && probability && !d.strataVar)
    out.push({ code: 'strata_var_missing', severity: 'error' });
  if ((d.method === 'cluster' || d.method === 'multistage') && probability && !d.clusterVar)
    out.push({ code: 'cluster_var_missing', severity: 'error' });
  if (
    probability &&
    d.method === 'stratified' &&
    stats.smallestStratum !== null &&
    stats.smallestStratum < 2
  )
    out.push({ code: 'tiny_stratum', severity: 'warning' });
  if ((d.method === 'cluster' || d.method === 'multistage') && probability && plan.size.deff <= 1)
    out.push({ code: 'clusters_need_deff', severity: 'warning' });
  if (probability && d.method === 'cluster' && stats.clusters && d.clusters > stats.clusters)
    out.push({
      code: 'too_few_clusters',
      severity: 'warning',
      params: { asked: d.clusters, available: stats.clusters },
    });
  if (stats.excluded)
    out.push({ code: 'coverage_loss', severity: 'info', params: { excluded: stats.excluded } });
  if (!plan.source.populationKnown) out.push({ code: 'population_unknown', severity: 'info' });
  if (d.family === 'census') out.push({ code: 'census_no_sampling_error', severity: 'info' });
  else if (!probability) out.push({ code: 'no_margin_of_error', severity: 'warning' });
  else
    out.push({
      code: 'margin_by_design',
      severity: 'info',
      params: { required: sizes.required, selected: sizes.selected },
    });
  if (plan.quotas.length)
    out.push({ code: probability ? 'quotas_as_control' : 'quotas_as_selection', severity: 'info' });
  if (plan.substitution.allowed)
    out.push({
      code: probability ? 'substitution_bias' : 'substitution_recorded',
      severity: 'info',
    });
  return out;
}
