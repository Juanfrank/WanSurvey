import { describe, expect, it } from 'vitest';
import { windowOf, windowsIn } from '../src/metrics/goal-periods.js';

describe('goal windows', () => {
  // 2026-10-01 is a Thursday.
  it('finds the window of a day, clipped to the goal', () => {
    expect(windowOf('period', '2026-10-01', '2026-10-31', '2026-10-15')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(windowOf('daily', '2026-10-01', '2026-10-31', '2026-10-15')).toEqual({
      from: '2026-10-15',
      to: '2026-10-15',
    });
    expect(windowOf('business_days', '2026-10-01', '2026-10-31', '2026-10-17')).toBeNull();
    expect(windowOf('weekly', '2026-10-01', '2026-10-31', '2026-10-01')).toEqual({
      from: '2026-10-01',
      to: '2026-10-04',
    });
    expect(windowOf('weekly', '2026-10-01', '2026-10-31', '2026-10-15')).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(windowOf('monthly', '2026-10-10', '2026-12-31', '2026-10-20')).toEqual({
      from: '2026-10-10',
      to: '2026-10-31',
    });
  });

  it('counts the windows of a goal', () => {
    expect(windowsIn('period', '2026-10-01', '2026-10-31')).toBe(1);
    expect(windowsIn('daily', '2026-10-01', '2026-10-31')).toBe(31);
    expect(windowsIn('business_days', '2026-10-01', '2026-10-31')).toBe(22);
    expect(windowsIn('weekly', '2026-10-01', '2026-10-31')).toBe(5);
    expect(windowsIn('monthly', '2026-10-15', '2026-12-01')).toBe(3);
  });
});
