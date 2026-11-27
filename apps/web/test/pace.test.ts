import { describe, expect, it } from 'vitest';
import { fieldPace, planProgress, quotaStatus } from '../src/analysis/pace.js';

const days = (from: number, counts: number[]) =>
  counts.map((n, i) => ({ day: `2026-11-${String(from + i).padStart(2, '0')}`, completes: n }));

describe('fieldwork pace', () => {
  const plan = { target: 120, startsOn: '2026-11-13', endsOn: '2026-11-24' };

  it('needs a target and both dates', () => {
    expect(
      fieldPace({ ...plan, target: null, completes: 0, today: '2026-11-15', byDay: [] }),
    ).toBeNull();
    expect(
      fieldPace({ ...plan, endsOn: null, completes: 0, today: '2026-11-15', byDay: [] }),
    ).toBeNull();
  });

  it('is on track at the planned pace, with the days needed and the forecast', () => {
    // 12 days, 10 a day; on day 5, 40 are due from the 4 days gone and 40 are in.
    const p = fieldPace({
      ...plan,
      completes: 40,
      today: '2026-11-17',
      byDay: days(13, [10, 10, 10, 10, 0]),
    })!;
    expect(p).toMatchObject({ totalDays: 12, day: 5, expected: 40, remaining: 80 });
    expect(p.requiredPerDay).toBe(10);
    // 40 over the 5 days so far: 8 a day, 80 more take 10 days → 26 November, after the end.
    expect(p.currentPerDay).toBe(8);
    expect(p.forecast).toBe('2026-11-26');
    expect(p.state).toBe('behind');
  });

  it('is behind with fewer completes than due, and on track when ahead', () => {
    const behind = fieldPace({
      ...plan,
      completes: 20,
      today: '2026-11-17',
      byDay: days(13, [5, 5, 5, 5]),
    })!;
    expect(behind.state).toBe('behind');
    expect(behind.requiredPerDay).toBe(13);
    const ahead = fieldPace({
      ...plan,
      completes: 70,
      today: '2026-11-17',
      byDay: days(13, [20, 20, 15, 15]),
    })!;
    expect(ahead.state).toBe('on_track');
    expect(ahead.forecast! <= plan.endsOn).toBe(true);
  });

  it('tells a plan not started, met and ended', () => {
    expect(fieldPace({ ...plan, completes: 0, today: '2026-11-10', byDay: [] })!.state).toBe(
      'upcoming',
    );
    expect(fieldPace({ ...plan, completes: 120, today: '2026-11-20', byDay: [] })!.state).toBe(
      'met',
    );
    const ended = fieldPace({ ...plan, completes: 100, today: '2026-11-30', byDay: [] })!;
    expect(ended.state).toBe('ended');
    expect(ended.requiredPerDay).toBeNull();
  });
});

describe('quota status', () => {
  it('uses the target when there is one, and puts the riskiest first', () => {
    const progress = planProgress('2026-11-13', '2026-11-24', '2026-11-19'); // 6 of 12 days gone
    expect(progress).toBe(0.5);
    const rows = quotaStatus(
      [
        { id: 'a', name: 'Women', max: 150, target: 100, count: 16 },
        { id: 'b', name: 'Men', max: 50, target: null, count: 46 },
        { id: 'c', name: 'Young', max: 40, target: null, count: 40 },
        { id: 'd', name: 'Old', max: 40, target: 30, count: 20 },
      ],
      progress,
    );
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['a', 'behind'],
      ['b', 'near_full'],
      ['d', 'on_track'],
      ['c', 'full'],
    ]);
    expect(rows[0]).toMatchObject({ aim: 100, missing: 84, expected: 50 });
  });

  it('without dates, nothing is behind', () => {
    const [row] = quotaStatus([{ id: 'a', name: 'A', max: 100, target: null, count: 1 }], null);
    expect(row!.state).toBe('on_track');
    expect(row!.expected).toBeNull();
  });
});
