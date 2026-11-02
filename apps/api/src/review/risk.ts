import type { RiskSettings } from '@wansurvey/schema';
import type { Flags } from './flags.js';

/** Fraud-risk signals (ADR 0001, decision 2): pure functions; the service feeds them data. */

export interface Point {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres. */
export function metresBetween(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

const baseName = (key: string) =>
  key
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!;

/** Median time on each question (by variable name) over other interviews' timings. */
export function medianDwell(samples: { key: string; ms: number }[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const s of samples) {
    const k = baseName(s.key);
    (by.get(k) ?? by.set(k, []).get(k)!).push(s.ms);
  }
  return new Map([...by].map(([k, v]) => [k, median(v)]));
}

/** Too few comparisons say nothing: a question needs a median, and the interview several. */
const MIN_TIMED = 5;
const MIN_MEDIAN_MS = 1000;

/** Questions answered in less than `fraction` of the median time. Null: not enough to judge. */
export function shortPages(
  own: { key: string; ms: number }[],
  medians: Map<string, number>,
  cfg: Pick<RiskSettings, 'shortPageFraction' | 'shortPageShare'>,
): Flags['shortPages'] | undefined {
  const timed = own.filter((o) => (medians.get(baseName(o.key)) ?? 0) >= MIN_MEDIAN_MS);
  if (timed.length < MIN_TIMED) return undefined;
  const short = timed.filter(
    (o) => o.ms < (medians.get(baseName(o.key)) ?? 0) * cfg.shortPageFraction,
  ).length;
  return short / timed.length >= cfg.shortPageShare ? { short, of: timed.length } : undefined;
}

/**
 * How many interviews (this one included) lie within `metres` of this one's position. Only a
 * cluster of `min` or more is reported, so a household visited twice is not a signal.
 */
export function positionCluster(
  mine: Point,
  others: Point[],
  cfg: Pick<RiskSettings, 'clusterMetres' | 'clusterMinInterviews'>,
): Flags['positionCluster'] | undefined {
  const near = others.filter((o) => metresBetween(mine, o) <= cfg.clusterMetres).length + 1;
  return near >= cfg.clusterMinInterviews
    ? { interviews: near, metres: cfg.clusterMetres }
    : undefined;
}

export function farFromAddress(
  mine: Point,
  address: Point | null,
  cfg: Pick<RiskSettings, 'farFromAddressMetres'>,
): Flags['farFromAddress'] | undefined {
  if (!address || cfg.farFromAddressMetres === null) return undefined;
  const metres = metresBetween(mine, address);
  return metres > cfg.farFromAddressMetres ? { metres } : undefined;
}

/** The flags that count as fraud signals, with the weight each adds. */
export function riskOf(flags: Flags, weights: RiskSettings['weights']): number {
  let r = 0;
  if (flags.speeding !== undefined) r += weights.speeding;
  if (flags.straightlining?.length) r += weights.straightlining;
  if (flags.shortPages) r += weights.shortPages;
  if (flags.positionCluster) r += weights.positionCluster;
  if (flags.farFromAddress) r += weights.farFromAddress;
  return r;
}
