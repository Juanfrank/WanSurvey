import type { SpecialKind } from '@wansurvey/schema';

export interface SpecialValue {
  $special: SpecialKind;
}

/** Runtime value in the logic language. `null` means unanswered / not applicable. */
export type Value =
  null | number | string | boolean | SpecialValue | Value[] | { [key: string]: Value };

export function isSpecial(v: unknown): v is SpecialValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { $special?: unknown }).$special === 'string' &&
    Object.keys(v).length === 1
  );
}

export function special(kind: SpecialKind): SpecialValue {
  return { $special: kind };
}

/** Answered = holds a value, including DK/Refused. Empty strings and empty selections are unanswered. */
export function isAnswered(v: Value | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

/** Missing for comparison purposes: unanswered or a special code. Comparisons with it are false. */
export function isMissing(v: Value | undefined): boolean {
  return !isAnswered(v) || isSpecial(v);
}

export function truthy(v: Value | undefined): boolean {
  if (v === null || v === undefined || isSpecial(v)) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Codes may be numbers or strings; `1` and `"1"` compare equal so imported sample data still matches. */
export function looseEquals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return b.trim() !== '' && Number(b) === a;
  if (typeof a === 'string' && typeof b === 'number') return a.trim() !== '' && Number(a) === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => looseEquals(x, b[i]!));
  }
  return false;
}

/** Returns <0, 0, >0, or null when the two values are not comparable. */
export function compareValues(a: Value, b: Value): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (
    typeof a === 'number' &&
    typeof b === 'string' &&
    b.trim() !== '' &&
    !Number.isNaN(Number(b))
  ) {
    return a - Number(b);
  }
  if (
    typeof a === 'string' &&
    typeof b === 'number' &&
    a.trim() !== '' &&
    !Number.isNaN(Number(a))
  ) {
    return Number(a) - b;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return null;
}

export function toNumber(v: Value | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

export function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/** Converts arbitrary JSON (sample data, profiles) into a logic Value. */
export function fromUnknown(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(fromUnknown);
  if (typeof v === 'object') {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    const out: { [k: string]: Value } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = fromUnknown(x);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates (ISO strings, computed in UTC so results never depend on device timezone)
// ---------------------------------------------------------------------------

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parses an ISO date/date-time into epoch ms (UTC). Returns null when invalid. */
export function parseIsoDate(v: Value | undefined): number | null {
  if (typeof v !== 'string') return null;
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? 0),
    Number(mi ?? 0),
    Number(s ?? 0),
  );
  const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
    ms -= sign * offset;
  }
  return Number.isFinite(ms) ? ms : null;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
const timeOfDay = (ms: number) => ((ms % DAY_MS) + DAY_MS) % DAY_MS;

/** Whole calendar months from a to b (negative if b is before a). */
export function monthsBetween(aMs: number, bMs: number): number {
  const a = new Date(aMs);
  const b = new Date(bMs);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  const aRest = a.getUTCDate() * DAY_MS + timeOfDay(aMs);
  const bRest = b.getUTCDate() * DAY_MS + timeOfDay(bMs);
  if (months > 0 && bRest < aRest) months--;
  else if (months < 0 && bRest > aRest) months++;
  return months;
}

/** Own-property lookup, so names like `constructor` never resolve to Object.prototype members. */
export function own<T>(
  obj: Readonly<Record<string, T>> | null | undefined,
  key: string,
): T | undefined {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
