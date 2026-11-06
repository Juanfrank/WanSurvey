import { CatiSettings } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import {
  caseTimezone,
  eligibleInOrder,
  ineligible,
  nextEligible,
  type QueueCase,
} from '../src/cati/queue.js';

const me = 'me';
const now = new Date('2026-10-12T15:00:00Z'); // 10:00 in Lima, 00:00 in Tokyo
const settings = CatiSettings.parse({});
const o = { me, now, settings, pool: false, projectTimezone: 'America/Lima' };
const mk = (id: string, x: Partial<QueueCase> = {}): QueueCase => ({
  id,
  priority: 0,
  attempts: 0,
  lastAttemptAt: null,
  nextContactAt: null,
  disposition: null,
  assignedTo: me,
  callbackUserId: null,
  callLockUserId: null,
  callLockUntil: null,
  timezone: undefined,
  ...x,
});
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe('call queue', () => {
  it('uses the case time zone when valid, else the project one', () => {
    expect(caseTimezone('Asia/Tokyo', 'America/Lima')).toBe('Asia/Tokyo');
    expect(caseTimezone('Nowhere/Land', 'America/Lima')).toBe('America/Lima');
    expect(caseTimezone(undefined, 'America/Lima')).toBe('America/Lima');
  });

  it('respects calling hours in the respondent’s time zone', () => {
    expect(ineligible(mk('a'), o)).toBeNull();
    expect(ineligible(mk('b', { timezone: 'Asia/Tokyo' }), o)).toBe('outside_hours');
  });

  it('skips cases locked by someone else until the lock expires', () => {
    const locked = mk('a', { callLockUserId: 'other', callLockUntil: new Date(now.getTime() + 1) });
    expect(ineligible(locked, o)).toBe('locked');
    expect(ineligible({ ...locked, callLockUntil: ago(1) }, o)).toBeNull();
    expect(ineligible({ ...locked, callLockUserId: me }, o)).toBeNull();
  });

  it('stops after the maximum attempts, but keeps callbacks', () => {
    expect(ineligible(mk('a', { attempts: 8 }), o)).toBe('max_attempts');
    expect(
      ineligible(mk('a', { attempts: 8, disposition: 'CALLBACK', nextContactAt: ago(1) }), o),
    ).toBeNull();
  });

  it('serves only the caller’s cases, plus free ones in pool mode', () => {
    expect(ineligible(mk('a', { assignedTo: 'other' }), o)).toBe('not_yours');
    expect(ineligible(mk('a', { assignedTo: null }), o)).toBe('not_yours');
    expect(ineligible(mk('a', { assignedTo: null }), { ...o, pool: true })).toBeNull();
    const cb = mk('a', { disposition: 'CALLBACK', nextContactAt: ago(1), callbackUserId: 'other' });
    expect(ineligible(cb, o)).toBe('not_yours');
  });

  it('serves first a callback the caller made the next one, even before it is due', () => {
    const later = mk('cb-later', {
      disposition: 'CALLBACK',
      nextContactAt: new Date(now.getTime() + 3_600_000),
      callbackUserId: me,
    });
    // Not pinned: waits for its time. Pinned by the caller: called now, and first.
    expect(ineligible(later, o)).toBe('not_due');
    expect(ineligible({ ...later, pinnedBy: me }, o)).toBeNull();
    // Pinned by someone else it still waits.
    expect(ineligible({ ...later, pinnedBy: 'other' }, o)).toBe('not_due');
    const cs = [
      mk('new-high', { priority: 9 }),
      mk('cb-due', { disposition: 'CALLBACK', nextContactAt: ago(5), callbackUserId: me }),
      { ...later, pinnedBy: me },
    ];
    expect(eligibleInOrder(cs, o).map((c) => c.id)).toEqual(['cb-later', 'cb-due', 'new-high']);
    // Calling hours still apply.
    expect(ineligible({ ...later, pinnedBy: me, timezone: 'Asia/Tokyo' }, o)).toBe('outside_hours');
  });

  it('orders due callbacks (mine first), then new cases by priority, then retries', () => {
    const cs = [
      mk('retry-old', { attempts: 1, lastAttemptAt: ago(300) }),
      mk('retry-new', { attempts: 1, lastAttemptAt: ago(200) }),
      mk('new-low'),
      mk('new-high', { priority: 5 }),
      mk('cb-anyone', { disposition: 'CALLBACK', nextContactAt: ago(10) }),
      mk('cb-mine', { disposition: 'CALLBACK', nextContactAt: ago(1), callbackUserId: me }),
      mk('cb-later', { disposition: 'CALLBACK', nextContactAt: new Date(now.getTime() + 60_000) }),
    ];
    expect(eligibleInOrder(cs, o).map((c) => c.id)).toEqual([
      'cb-mine',
      'cb-anyone',
      'new-high',
      'new-low',
      'retry-old',
      'retry-new',
    ]);
  });

  it('says why nothing can be called', () => {
    expect(nextEligible([], o)).toEqual({ reason: 'empty' });
    expect(nextEligible([mk('a', { timezone: 'Asia/Tokyo' })], o)).toEqual({
      reason: 'outside_hours',
    });
  });
});
