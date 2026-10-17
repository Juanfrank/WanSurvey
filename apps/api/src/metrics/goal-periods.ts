/** How often a goal's target applies: once for the whole period, or per day, week or month. */
export const FREQUENCIES = ['period', 'daily', 'business_days', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (d: string) => {
  const w = new Date(ms(d)).getUTCDay();
  return w >= 1 && w <= 5;
};
/** Days from one ISO date to another, both included. */
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY) + 1;
const clip = (from: string, to: string, start: string, end: string) => ({
  from: from < start ? start : from,
  to: to > end ? end : to,
});

/**
 * The window of a goal that holds `day` (clipped to the goal's dates), or null when the day
 * counts for nothing (a weekend for a business-day goal).
 */
export function windowOf(
  f: Frequency,
  start: string,
  end: string,
  day: string,
): { from: string; to: string } | null {
  switch (f) {
    case 'period':
      return { from: start, to: end };
    case 'daily':
      return { from: day, to: day };
    case 'business_days':
      return weekday(day) ? { from: day, to: day } : null;
    case 'weekly': {
      // Monday to Sunday.
      const back = (new Date(ms(day)).getUTCDay() + 6) % 7;
      const monday = ms(day) - back * DAY;
      return clip(iso(monday), iso(monday + 6 * DAY), start, end);
    }
    case 'monthly': {
      const d = new Date(ms(day));
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
      return clip(iso(first), iso(last), start, end);
    }
  }
}

/** How many windows a goal has: its target for the whole period is the target times this. */
export function windowsIn(f: Frequency, start: string, end: string): number {
  if (f === 'period') return 1;
  const seen = new Set<string>();
  for (let t = ms(start); t <= ms(end); t += DAY) {
    const w = windowOf(f, start, end, iso(t));
    if (w) seen.add(w.from);
  }
  return seen.size;
}
