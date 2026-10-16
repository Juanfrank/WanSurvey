import { SamplingPlanInput } from '@wansurvey/schema/sampling';
import { describe, expect, it } from 'vitest';
import {
  planSizes,
  allocate,
  operationalSize,
  requiredSize,
  selectSample,
  zFor,
  type FrameUnit,
} from '../src/sampling.js';

const frame = (n: number, f: (i: number) => Partial<FrameUnit> = () => ({})): FrameUnit[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${String(i).padStart(4, '0')}`, ...f(i) }));

describe('sample size', () => {
  it('z for usual confidence levels', () => {
    expect(zFor(0.95)).toBeCloseTo(1.96, 2);
    expect(zFor(0.9)).toBeCloseTo(1.645, 3);
    expect(zFor(0.99)).toBeCloseTo(2.576, 3);
  });

  it('a proportion at 95% ± 5%: 385, fewer with a known population, more with a design effect', () => {
    const objective = { kind: 'proportion', confidence: 0.95, margin: 0.05, p: 0.5 } as const;
    expect(requiredSize({ objective, deff: 1 }).required).toBe(385);
    const fpc = requiredSize({ objective, deff: 1, population: 1000 });
    expect(fpc).toMatchObject({ required: 278, fpcApplied: true });
    expect(requiredSize({ objective, deff: 1.5 }).required).toBe(577);
  });

  it('a mean and a difference of proportions', () => {
    expect(
      requiredSize({
        objective: { kind: 'mean', confidence: 0.95, margin: 2, sd: 10 },
        deff: 1,
      }).required,
    ).toBe(97);
    // 50% vs 60%, 95% confidence, 80% power: about 388 per group.
    const d = requiredSize({
      objective: { kind: 'difference', confidence: 0.95, power: 0.8, p1: 0.5, p2: 0.6 },
      deff: 1,
      population: 500,
    });
    expect(d.required).toBeGreaterThanOrEqual(385);
    expect(d.required).toBeLessThanOrEqual(390);
    expect(d.fpcApplied).toBe(false);
  });

  it('separates completes required, units to select and cases with reserves', () => {
    expect(
      operationalSize({ required: 400, eligibility: 0.8, response: 0.5, reserve: 0.1 }),
    ).toEqual({
      required: 400,
      selected: 1000,
      reserves: 100,
      cases: 1100,
    });
  });
});

describe('selection', () => {
  it('allocates proportionally with largest remainders, equally, or as given', () => {
    expect(allocate({ a: 50, b: 30, c: 20 }, 10, 'proportional')).toEqual({ a: 5, b: 3, c: 2 });
    expect(allocate({ a: 55, b: 25, c: 20 }, 10, 'proportional')).toEqual({ a: 6, b: 2, c: 2 });
    expect(allocate({ a: 50, b: 3 }, 10, 'equal')).toEqual({ a: 5, b: 3 });
    expect(allocate({ a: 50, b: 3 }, 0, 'manual', { a: 7, b: 9 })).toEqual({ a: 7, b: 3 });
  });

  it('simple random sampling: n units, π = n/N, the same with the same seed', () => {
    const units = frame(200);
    const a = selectSample(units, { method: 'srs', n: 20 }, { seed: 's1', reserve: 0.25 });
    expect(a.main).toHaveLength(20);
    expect(new Set(a.main.map((u) => u.id)).size).toBe(20);
    expect(a.main.every((u) => u.prob === 0.1)).toBe(true);
    expect(a.reserve).toHaveLength(5);
    expect(a.reserve.map((r) => r.order)).toEqual([1, 2, 3, 4, 5]);
    expect(a.reserve.some((r) => a.main.some((m) => m.id === r.id))).toBe(false);
    const b = selectSample(units, { method: 'srs', n: 20 }, { seed: 's1', reserve: 0.25 });
    expect(b.main.map((u) => u.id)).toEqual(a.main.map((u) => u.id));
    const c = selectSample(units, { method: 'srs', n: 20 }, { seed: 's2' });
    expect(c.main.map((u) => u.id)).not.toEqual(a.main.map((u) => u.id));
  });

  it('systematic: evenly spread over the sorted list', () => {
    const units = frame(100, (i) => ({ sortKey: i }));
    const r = selectSample(units, { method: 'systematic', n: 10 }, { seed: 'x' });
    const idx = r.main.map((u) => Number(u.id.slice(1))).sort((a, b) => a - b);
    for (let i = 1; i < idx.length; i++) expect(idx[i]! - idx[i - 1]!).toBe(10);
  });

  it('stratified: per stratum n_h, π = n_h/N_h, reserves from the same stratum', () => {
    const units = frame(100, (i) => ({ stratum: i < 70 ? 'urban' : 'rural' }));
    const r = selectSample(
      units,
      { method: 'stratified', n: 20, allocation: 'equal', within: 'srs' },
      { seed: 'st', reserve: 0.2 },
    );
    const urban = r.main.filter((u) => u.stratum === 'urban');
    const rural = r.main.filter((u) => u.stratum === 'rural');
    expect(urban).toHaveLength(10);
    expect(rural).toHaveLength(10);
    expect(urban[0]!.prob).toBeCloseTo(10 / 70);
    expect(rural[0]!.prob).toBeCloseTo(10 / 30);
    expect(r.reserve.filter((u) => u.stratum === 'rural')).toHaveLength(2);
    expect(r.strata).toEqual(
      expect.arrayContaining([{ stratum: 'rural', population: 30, selected: 10, reserve: 2 }]),
    );
  });

  it('clusters: whole clusters at m/M, or PPS then a fixed number per cluster', () => {
    const units = frame(100, (i) => ({ cluster: `c${Math.floor(i / 10)}` }));
    const one = selectSample(units, { method: 'cluster', clusters: 3, pps: false }, { seed: 'c' });
    expect(one.main).toHaveLength(30);
    expect(one.main.every((u) => Math.abs(u.prob - 0.3) < 1e-9)).toBe(true);
    const two = selectSample(
      units,
      { method: 'cluster', clusters: 4, pps: true, perCluster: 5 },
      { seed: 'c' },
    );
    expect(two.main).toHaveLength(20);
    // Equal sizes: π = (4 × 10/100) × (5/10) = 0.2 for every unit.
    expect(two.main.every((u) => Math.abs(u.prob - 0.2) < 1e-9)).toBe(true);
  });

  it('multistage: strata, PPS clusters within each, units within clusters', () => {
    const units = frame(120, (i) => ({
      stratum: i < 60 ? 'north' : 'south',
      cluster: `c${Math.floor(i / 10)}`,
    }));
    const r = selectSample(
      units,
      { method: 'multistage', clustersPerStratum: 2, perCluster: 4 },
      { seed: 'm' },
    );
    expect(r.main).toHaveLength(16);
    expect(r.strata.map((s) => s.selected)).toEqual([8, 8]);
  });

  it('warns when a stratum has fewer units than asked', () => {
    const units = frame(10, (i) => ({ stratum: i < 8 ? 'a' : 'b' }));
    const r = selectSample(
      units,
      {
        method: 'stratified',
        n: 0,
        allocation: 'manual',
        perStratum: { a: 4, b: 5 },
        within: 'srs',
      },
      { seed: 'w' },
    );
    expect(r.main).toHaveLength(6);
  });
});

describe('census sizes', () => {
  it('takes every eligible unit, with no reserves and no size formula', () => {
    const sizes = planSizes(
      {
        source: SamplingPlanInput.parse({}).source,
        size: { ...SamplingPlanInput.parse({}).size, response: 0.8, reserve: 0.2 },
        design: { family: 'census' },
      },
      10,
    );
    expect(sizes).toMatchObject({ required: 8, selected: 10, reserves: 0, cases: 10 });
  });
});
