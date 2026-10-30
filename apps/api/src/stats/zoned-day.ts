/**
 * Local days of a project's time zone as UTC instants. The statistics group submissions by the
 * project's local day, and SQL Server's `AT TIME ZONE` takes Windows zone names, not the IANA
 * names the projects store, so the day's bounds are worked out here (with `Intl`) and the database
 * only compares instants.
 */
const fmt = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at an instant, in minutes. */
export function offsetMinutes(timeZone: string, at: number): number {
  let f = fmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmt.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** The instant a local calendar day (YYYY-MM-DD) starts in the zone. */
export function dayStart(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  let t = wall;
  // Twice settles it, also on the day a zone changes its clock.
  for (let i = 0; i < 3; i++) t = wall - offsetMinutes(timeZone, t) * 60_000;
  return new Date(t);
}

/** The next calendar day as YYYY-MM-DD. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** [start, end) of a local day: end is the start of the next day (days may be 23 or 25 hours). */
export function dayBounds(day: string, timeZone: string): { from: Date; to: Date } {
  return { from: dayStart(day, timeZone), to: dayStart(nextDay(day), timeZone) };
}

/** The local day of an instant in the zone, as YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  return new Date(at.getTime() + offsetMinutes(timeZone, at.getTime()) * 60_000)
    .toISOString()
    .slice(0, 10);
}
