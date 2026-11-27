/**
 * Fieldwork pace for the dashboard: where the completes stand against the planned dates, the
 * completes needed each remaining day, the current pace and the date it would reach the target;
 * and the state of each quota cell. Dates are local days (YYYY-MM-DD) of the project.
 */

const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** Days from `a` to `b` (negative when `b` is earlier). */
export const daysFrom = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export const addDays = (d: string, n: number) =>
  new Date(toMs(d) + n * DAY_MS).toISOString().slice(0, 10);

/** Days of recent pace (the current pace is the mean over the last week of fieldwork). */
export const PACE_DAYS = 7;

export type PaceState = 'upcoming' | 'on_track' | 'behind' | 'met' | 'ended';

export interface Pace {
  state: PaceState;
  /** Fieldwork days in the plan, and the current one (1-based, within the plan). */
  totalDays: number;
  day: number;
  /** Completes due before today at an even pace (the days already gone). */
  expected: number;
  /** Completes still to reach the target. */
  remaining: number;
  /** Completes needed each day left (today included); null when no day is left or none needed. */
  requiredPerDay: number | null;
  /** Mean completes per day over the last days of fieldwork; null before it starts. */
  currentPerDay: number | null;
  /** Day the target would be reached at the current pace; null when it cannot be told. */
  forecast: string | null;
}

/**
 * The pace of fieldwork against its planned dates. Null without a target or without both dates.
 */
export function fieldPace(v: {
  target: number | null;
  completes: number;
  startsOn: string | null;
  endsOn: string | null;
  today: string;
  byDay: { day: string; completes: number }[];
}): Pace | null {
  const { target, completes, startsOn, endsOn, today } = v;
  if (!target || !startsOn || !endsOn || endsOn < startsOn) return null;
  const totalDays = daysFrom(startsOn, endsOn) + 1;
  const day = Math.max(0, Math.min(totalDays, daysFrom(startsOn, today) + 1));
  const expected = Math.round(target * (planProgress(startsOn, endsOn, today) ?? 0));
  const remaining = Math.max(0, target - completes);
  const daysLeft = today > endsOn ? 0 : totalDays - Math.max(day, 1) + 1;
  const requiredPerDay = remaining && daysLeft ? Math.ceil(remaining / daysLeft) : null;
  // The last week of fieldwork up to today (fewer days at the start).
  let currentPerDay: number | null = null;
  if (day > 0) {
    const last = today > endsOn ? endsOn : today;
    const span = Math.min(PACE_DAYS, daysFrom(startsOn, last) + 1);
    const from = addDays(last, -(span - 1));
    const sum = v.byDay
      .filter((d) => d.day >= from && d.day <= last)
      .reduce((a, d) => a + d.completes, 0);
    currentPerDay = sum / span;
  }
  const forecast =
    remaining === 0
      ? null
      : currentPerDay && currentPerDay > 0
        ? addDays(today, Math.ceil(remaining / currentPerDay) - 1)
        : null;
  const state: PaceState =
    remaining === 0
      ? 'met'
      : day === 0
        ? 'upcoming'
        : today > endsOn
          ? 'ended'
          : completes < expected || (forecast !== null && forecast > endsOn)
            ? 'behind'
            : 'on_track';
  return { state, totalDays, day, expected, remaining, requiredPerDay, currentPerDay, forecast };
}

export type QuotaState = 'full' | 'near_full' | 'behind' | 'met' | 'on_track';

/** Share of the cap from which a cell is nearly full. */
export const NEAR_FULL = 0.9;

export interface QuotaRow {
  id: string;
  name: string;
  max: number;
  target: number | null;
  count: number;
}

export interface QuotaStatus extends QuotaRow {
  /** What the cell aims at: its target, or the cap when it has none. */
  aim: number;
  /** Share of the aim reached (0–1+), null when the aim is 0. */
  share: number | null;
  /** Completes still to reach the aim. */
  missing: number;
  /** Completes due by today at an even pace over the planned dates; null without dates. */
  expected: number | null;
  state: QuotaState;
}

const ORDER: Record<QuotaState, number> = { behind: 0, near_full: 1, on_track: 2, met: 3, full: 4 };

/**
 * Each quota cell with its aim, share, missing completes and state, riskiest first: behind
 * the pace, then nearly full (time to stop sending cases that fall in it), then the rest.
 * `progress` is the share of planned fieldwork days gone (`planProgress`), or null without dates.
 */
export function quotaStatus(quotas: QuotaRow[], progress: number | null): QuotaStatus[] {
  return quotas
    .map((q) => {
      const aim = Math.min(q.target ?? q.max, q.max);
      const missing = Math.max(0, aim - q.count);
      const expected = progress === null ? null : Math.round(aim * progress);
      const state: QuotaState =
        q.count >= q.max
          ? 'full'
          : q.max > 0 && q.count >= q.max * NEAR_FULL
            ? 'near_full'
            : q.count >= aim
              ? 'met'
              : expected !== null && q.count < expected
                ? 'behind'
                : 'on_track';
      return { ...q, aim, share: aim ? q.count / aim : null, missing, expected, state };
    })
    .sort(
      (a, b) =>
        ORDER[a.state] - ORDER[b.state] ||
        (b.expected ?? 0) - b.count - ((a.expected ?? 0) - a.count) ||
        (a.share ?? 1) - (b.share ?? 1),
    );
}

/** Share (0–1) of the planned fieldwork days gone before today, or null without dates. */
export function planProgress(
  startsOn: string | null,
  endsOn: string | null,
  today: string,
): number | null {
  if (!startsOn || !endsOn || endsOn < startsOn) return null;
  const total = daysFrom(startsOn, endsOn) + 1;
  return Math.max(0, Math.min(total, daysFrom(startsOn, today))) / total;
}
