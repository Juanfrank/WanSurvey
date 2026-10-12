/** Whether a string names a time zone the platform knows (IANA, e.g. America/Lima). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant in a time zone. */
export function zonedParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Minutes since local midnight in a time zone. */
export function localMinutes(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  return p.hour * 60 + p.minute;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/**
 * Whether `at` falls inside `from`–`to` local time. A window may wrap past midnight; equal
 * ends mean all day.
 */
export function withinHours(at: Date, tz: string, hours: { from: string; to: string }): boolean {
  const now = localMinutes(at, tz);
  const from = minutesOf(hours.from);
  const to = minutesOf(hours.to);
  if (from === to) return true;
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/**
 * The instant at which the clock in `tz` shows `local` (`YYYY-MM-DDTHH:mm`), for date-time
 * pickers that work in the respondent's time zone.
 */
export function zonedToUtc(local: string, tz: string): Date {
  const [d, t = '00:00'] = local.split('T');
  const [y, mo, da] = d!.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const wanted = Date.UTC(y!, mo! - 1, da!, h!, mi!);
  // Two passes settle the offset, also around daylight-saving changes.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** `YYYY-MM-DDTHH:mm` as the clock in `tz` shows `at` (for date-time inputs). */
export function utcToZoned(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
