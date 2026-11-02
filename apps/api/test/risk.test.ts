import { RiskSettings } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import {
  farFromAddress,
  medianDwell,
  metresBetween,
  positionCluster,
  riskOf,
  shortPages,
} from '../src/review/risk.js';

const cfg = RiskSettings.parse({});
const here = { lat: -12.0464, lng: -77.0428 };
/** About 11 m north per 0.0001 degree of latitude. */
const north = (m: number) => ({ lat: here.lat + m / 111_195, lng: here.lng });

describe('fraud-risk signals', () => {
  it('measures distance on the sphere', () => {
    expect(metresBetween(here, here)).toBe(0);
    expect(Math.abs(metresBetween(here, north(500)) - 500)).toBeLessThan(3);
  });

  it('flags a position cluster only from the configured number of interviews', () => {
    const near = [north(10), north(20), north(30)];
    expect(positionCluster(here, near.slice(0, 2), cfg)).toBeUndefined();
    expect(positionCluster(here, near, cfg)).toEqual({ interviews: 4, metres: 50 });
    expect(positionCluster(here, [north(500), north(900), north(1200)], cfg)).toBeUndefined();
  });

  it('flags distance from the address only when configured', () => {
    expect(farFromAddress(here, north(900), cfg)).toBeUndefined();
    const on = { ...cfg, farFromAddressMetres: 300 };
    expect(farFromAddress(here, north(900), on)?.metres).toBeGreaterThan(800);
    expect(farFromAddress(here, north(100), on)).toBeUndefined();
    expect(farFromAddress(here, null, on)).toBeUndefined();
  });

  it('flags interviews whose questions were answered far faster than the median', () => {
    const medians = medianDwell(
      ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].flatMap((key) =>
        [4000, 5000, 6000].map((ms) => ({ key, ms })),
      ),
    );
    const fast = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((key) => ({ key, ms: 600 }));
    expect(shortPages(fast, medians, cfg)).toEqual({ short: 5, of: 5 });
    const normal = fast.map((f) => ({ ...f, ms: 5000 }));
    expect(shortPages(normal, medians, cfg)).toBeUndefined();
    // Too few timed questions, or no usable median, say nothing.
    expect(shortPages(fast.slice(0, 3), medians, cfg)).toBeUndefined();
    expect(shortPages(fast, new Map(), cfg)).toBeUndefined();
    // Roster instances count by their variable name.
    expect(medianDwell([{ key: 'HH[2].AGE', ms: 3000 }]).get('AGE')).toBe(3000);
  });

  it('adds the weights of the fired signals only', () => {
    expect(riskOf({}, cfg.weights)).toBe(0);
    expect(riskOf({ otherText: 3, warningsOverridden: 2 }, cfg.weights)).toBe(0);
    expect(
      riskOf(
        {
          speeding: 800,
          shortPages: { short: 4, of: 5 },
          positionCluster: { interviews: 4, metres: 50 },
        },
        cfg.weights,
      ),
    ).toBe(30 + 25 + 35);
  });
});
