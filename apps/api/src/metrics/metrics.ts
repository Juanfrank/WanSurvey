/**
 * Interviewer metrics (M4, M5): pure formulas, unit tested against hand-computed figures.
 * Rates are fractions (0–1) or null when the denominator is zero.
 */

/** Case counts by AAPOR disposition group. */
export interface AaporCounts {
  /** 1.1 complete interviews */
  I: number;
  /** 1.2 partial interviews */
  P: number;
  /** 2.1x refusals and break-offs */
  R: number;
  /** 2.2x non-contacts */
  NC: number;
  /** 2.3x other eligible non-interviews */
  O: number;
  /** 3.x unknown eligibility */
  U: number;
  /** 4.x not eligible (left out of every rate) */
  NE: number;
}

export const emptyCounts = (): AaporCounts => ({ I: 0, P: 0, R: 0, NC: 0, O: 0, U: 0, NE: 0 });

/** Adds one case by its AAPOR code ("1.1", "2.12"…); no code counts as unknown eligibility. */
export function addDisposition(counts: AaporCounts, aapor: string | null | undefined): void {
  if (!aapor) counts.U++;
  else if (aapor === '1.1') counts.I++;
  else if (aapor.startsWith('1.')) counts.P++;
  else if (aapor.startsWith('2.1')) counts.R++;
  else if (aapor.startsWith('2.2')) counts.NC++;
  else if (aapor.startsWith('2.')) counts.O++;
  else if (aapor.startsWith('3.')) counts.U++;
  else counts.NE++;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** AAPOR Standard Definitions: response rate 1, cooperation rate 1, refusal rate 1, contact rate 1. */
export function aaporRates(c: AaporCounts) {
  const all = c.I + c.P + (c.R + c.NC + c.O) + c.U;
  return {
    rr1: ratio(c.I, all),
    coop1: ratio(c.I, c.I + c.P + c.R + c.O),
    ref1: ratio(c.R, all),
    con1: ratio(c.I + c.P + c.R + c.O, all),
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/**
 * Values further than `k` scaled median absolute deviations from the median: -1 low, 1 high,
 * 0 within. The MAD is scaled by 1.4826 so it estimates the standard deviation of normal data.
 * With fewer than 4 values, or no spread at all, nothing is an outlier.
 */
export function outliers(values: (number | null)[], k = 2): (-1 | 0 | 1)[] {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const med = median(present);
  if (med === null || present.length < 4) return values.map(() => 0);
  const mad = median(present.map((v) => Math.abs(v - med)))! * 1.4826;
  if (mad === 0) return values.map(() => 0);
  return values.map((v) =>
    v === null || !Number.isFinite(v) ? 0 : v > med + k * mad ? 1 : v < med - k * mad ? -1 : 0,
  );
}

/** Everything gathered for one interviewer over the period. */
export interface InterviewerInput {
  interviewerId: string;
  name: string;
  /** Completes by local day (YYYY-MM-DD). */
  completesByDay: Record<string, number>;
  submitted: number;
  approved: number;
  rejected: number;
  /** Active time of each complete interview, in ms. */
  completeLengthsMs: number[];
  /** Items on the path of the completes, and how many of them were don't know / refused. */
  items: number;
  itemsNonResponse: number;
  speeding: number;
  straightlining: number;
  backMoves: number;
  dials: number;
  cases: AaporCounts;
  /** Seconds between an answer on the device and its arrival on the server (CAPI). */
  syncLatencyS: number[];
}

export const METRIC_KEYS = [
  'completes',
  'perHour',
  'meanMinutes',
  'medianMinutes',
  'rr1',
  'coop1',
  'ref1',
  'con1',
  'dialsPerComplete',
  'itemNonResponse',
  'speeding',
  'straightlining',
  'rejectionRate',
  'backPerInterview',
  'syncLatencyS',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface InterviewerMetrics {
  interviewerId: string;
  name: string;
  completesByDay: Record<string, number>;
  values: Record<MetricKey, number | null>;
  /** Metrics outside ±2 scaled MAD of the team (filled by `rankTeam`). */
  outliers: Partial<Record<MetricKey, -1 | 1>>;
}

export function interviewerMetrics(x: InterviewerInput): InterviewerMetrics {
  const completes = x.completeLengthsMs.length;
  const activeMs = x.completeLengthsMs.reduce((a, b) => a + b, 0);
  const rates = aaporRates(x.cases);
  const m = mean(x.completeLengthsMs);
  const md = median(x.completeLengthsMs);
  return {
    interviewerId: x.interviewerId,
    name: x.name,
    completesByDay: x.completesByDay,
    values: {
      completes,
      perHour: activeMs > 0 ? completes / (activeMs / 3_600_000) : null,
      meanMinutes: m === null ? null : m / 60_000,
      medianMinutes: md === null ? null : md / 60_000,
      ...rates,
      dialsPerComplete: x.dials ? ratio(x.dials, completes) : null,
      itemNonResponse: ratio(x.itemsNonResponse, x.items),
      speeding: ratio(x.speeding, completes),
      straightlining: ratio(x.straightlining, completes),
      rejectionRate: ratio(x.rejected, x.approved + x.rejected),
      backPerInterview: ratio(x.backMoves, completes),
      syncLatencyS: median(x.syncLatencyS),
    },
    outliers: {},
  };
}

/** Marks each interviewer's metrics that stand out from the team; ranks by completes. */
export function rankTeam(rows: InterviewerMetrics[]): InterviewerMetrics[] {
  for (const key of METRIC_KEYS) {
    const flags = outliers(rows.map((r) => r.values[key]));
    flags.forEach((f, i) => {
      if (f) rows[i]!.outliers[key] = f;
    });
  }
  return [...rows].sort(
    (a, b) => (b.values.completes ?? 0) - (a.values.completes ?? 0) || a.name.localeCompare(b.name),
  );
}
