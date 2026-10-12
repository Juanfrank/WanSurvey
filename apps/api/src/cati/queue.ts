import { isTimeZone, withinHours, type CatiSettings } from '@wansurvey/schema';

/** A case as the call queue sees it. */
export interface QueueCase {
  id: string;
  priority: number;
  attempts: number;
  lastAttemptAt: Date | null;
  nextContactAt: Date | null;
  disposition: string | null;
  assignedTo: string | null;
  callbackUserId: string | null;
  callLockUserId: string | null;
  callLockUntil: Date | null;
  /** The respondent's time zone as stored in the sample (may be missing or invalid). */
  timezone: unknown;
}

export interface QueueOptions {
  me: string;
  now: Date;
  settings: CatiSettings;
  /** Pool mode: unassigned cases can be called by anyone. */
  pool: boolean;
  projectTimezone: string;
}

/** The respondent's time zone (K3): the case's `timezone` when valid, else the project's. */
export const caseTimezone = (tz: unknown, projectTimezone: string) =>
  typeof tz === 'string' && isTimeZone(tz) ? tz : projectTimezone;

const isCallback = (c: QueueCase) => c.disposition === 'CALLBACK' && !!c.nextContactAt;

/** Why a case cannot be called now, or null when it can. */
export function ineligible(c: QueueCase, o: QueueOptions): string | null {
  if (c.assignedTo ? c.assignedTo !== o.me : !o.pool) return 'not_yours';
  if (c.callLockUserId && c.callLockUserId !== o.me && c.callLockUntil && c.callLockUntil > o.now)
    return 'locked';
  if (c.nextContactAt && c.nextContactAt > o.now) return 'not_due';
  if (isCallback(c)) {
    // A callback promised to someone else waits for them.
    if (c.callbackUserId && c.callbackUserId !== o.me) return 'not_yours';
  } else if (c.attempts >= o.settings.maxAttempts) return 'max_attempts';
  const tz = caseTimezone(c.timezone, o.projectTimezone);
  if (!withinHours(o.now, tz, o.settings.callingHours)) return 'outside_hours';
  return null;
}

/**
 * Sort key (K1): callbacks due now (mine first, then anyone's), then cases never tried, then
 * due retries; by priority within each group, then the longest-waiting.
 */
export function rank(c: QueueCase, me: string): number[] {
  const group = isCallback(c) ? (c.callbackUserId === me ? 0 : 1) : c.attempts === 0 ? 2 : 3;
  return [
    group,
    group < 2 ? c.nextContactAt!.getTime() : 0,
    -c.priority,
    c.lastAttemptAt?.getTime() ?? 0,
  ];
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/** The cases that can be called now, best first. */
export function eligibleInOrder(cs: QueueCase[], o: QueueOptions): QueueCase[] {
  return cs
    .filter((c) => !ineligible(c, o))
    .map((c) => ({ c, k: rank(c, o.me) }))
    .sort((a, b) => compare(a.k, b.k) || a.c.id.localeCompare(b.c.id))
    .map((x) => x.c);
}

/** The next case to call, or why there is none (the most common reason among candidates). */
export function nextEligible(
  cs: QueueCase[],
  o: QueueOptions,
): { case: QueueCase } | { reason: string } {
  const [first] = eligibleInOrder(cs, o);
  if (first) return { case: first };
  const counts = new Map<string, number>();
  for (const c of cs) {
    const r = ineligible(c, o)!;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return { reason: top?.[0] ?? 'empty' };
}
