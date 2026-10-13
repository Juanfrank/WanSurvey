import { describe, expect, it } from 'vitest';
import {
  aaporRates,
  addDisposition,
  emptyCounts,
  interviewerMetrics,
  median,
  outliers,
  rankTeam,
  type InterviewerInput,
} from '../src/metrics/metrics.js';
import { localDay } from '../src/stats/stats.service.js';

describe('AAPOR rates', () => {
  it('match a hand-computed example', () => {
    const c = emptyCounts();
    // 40 completes, 10 partials, 20 refusals, 15 non-contacts, 5 other, 10 unknown, 7 not eligible.
    const add = (code: string | null, n: number) => {
      for (let i = 0; i < n; i++) addDisposition(c, code);
    };
    add('1.1', 40);
    add('1.2', 10);
    add('2.11', 15);
    add('2.12', 5);
    add('2.20', 15);
    add('2.33', 5);
    add('3.13', 6);
    add(null, 4);
    add('4.41', 7);
    expect(c).toEqual({ I: 40, P: 10, R: 20, NC: 15, O: 5, U: 10, NE: 7 });
    const r = aaporRates(c);
    // Denominator: 50 + 40 + 10 = 100.
    expect(r.rr1).toBeCloseTo(0.4);
    expect(r.ref1).toBeCloseTo(0.2);
    // Cooperation: 40 / (50 + 20 + 5) = 0.5333.
    expect(r.coop1).toBeCloseTo(40 / 75);
    // Contact: (50 + 20 + 5) / 100.
    expect(r.con1).toBeCloseTo(0.75);
  });

  it('are null without cases', () => {
    expect(aaporRates(emptyCounts())).toEqual({ rr1: null, coop1: null, ref1: null, con1: null });
  });
});

describe('outliers', () => {
  it('flag values beyond 2 scaled MADs of the median', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    // Median 10, MAD 1 → scaled 1.4826; limits 7.03 and 12.97.
    expect(outliers([9, 10, 10, 11, 10, 20, 2, null])).toEqual([0, 0, 0, 0, 0, 1, -1, 0]);
  });

  it('flag nothing with too few values or no spread', () => {
    expect(outliers([1, 100, 1])).toEqual([0, 0, 0]);
    expect(outliers([5, 5, 5, 5, 9])).toEqual([0, 0, 0, 0, 0]);
  });
});

const input = (id: string, over: Partial<InterviewerInput> = {}): InterviewerInput => ({
  interviewerId: id,
  name: id,
  completesByDay: {},
  submitted: 0,
  approved: 0,
  rejected: 0,
  completeLengthsMs: [],
  items: 0,
  itemsNonResponse: 0,
  speeding: 0,
  straightlining: 0,
  backMoves: 0,
  dials: 0,
  cases: emptyCounts(),
  syncLatencyS: [],
  ...over,
});

describe('interviewer metrics', () => {
  it('compute productivity, lengths and rates', () => {
    const m = interviewerMetrics(
      input('ana', {
        completeLengthsMs: [600_000, 1_200_000, 1_800_000],
        items: 60,
        itemsNonResponse: 3,
        speeding: 1,
        approved: 3,
        rejected: 1,
        backMoves: 6,
        dials: 12,
        syncLatencyS: [42],
      }),
    ).values;
    // 3 completes in 1 active hour.
    expect(m.completes).toBe(3);
    expect(m.perHour).toBeCloseTo(3);
    expect(m.meanMinutes).toBeCloseTo(20);
    expect(m.medianMinutes).toBeCloseTo(20);
    expect(m.itemNonResponse).toBeCloseTo(0.05);
    expect(m.speeding).toBeCloseTo(1 / 3);
    expect(m.rejectionRate).toBeCloseTo(0.25);
    expect(m.backPerInterview).toBeCloseTo(2);
    expect(m.dialsPerComplete).toBeCloseTo(4);
    expect(m.syncLatencyS).toBe(42);
  });

  it('rank the team by completes and mark outliers', () => {
    // Completes 10, 11, 9, 12, 1 and lengths 18, 20, 22, 21, 1 minutes.
    const counts = [10, 11, 9, 12, 1];
    const minutes = [18, 20, 22, 21, 1];
    const team = rankTeam(
      ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
        interviewerMetrics(
          input(id, { completeLengthsMs: Array(counts[i]).fill(minutes[i]! * 60_000) }),
        ),
      ),
    );
    expect(team.map((r) => r.interviewerId)).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(team[4]!.outliers.completes).toBe(-1);
    expect(team[4]!.outliers.meanMinutes).toBe(-1);
    expect(team[0]!.outliers).toEqual({});
  });
});

describe('localDay', () => {
  it('uses the project time zone', () => {
    const at = new Date('2026-03-01T03:30:00Z');
    expect(localDay(at, 'UTC')).toBe('2026-03-01');
    expect(localDay(at, 'America/Mexico_City')).toBe('2026-02-28');
    expect(localDay(at, 'Not/AZone')).toBe('2026-03-01');
  });
});
