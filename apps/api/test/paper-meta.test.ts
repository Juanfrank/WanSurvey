import { describe, expect, it } from 'vitest';
import { checkPaperMeta, latestToday } from '../src/papi/paper-meta.js';

const NOW = new Date('2026-11-27T10:00:00Z');

describe('the date and duration of a paper form, on the server (126)', () => {
  it('keeps valid values and missing ones', () => {
    expect(checkPaperMeta({ date: '2026-11-20', minutes: 45 }, NOW)).toEqual({
      payload: { date: '2026-11-20', minutes: 45 },
      invalid: false,
    });
    expect(checkPaperMeta({ date: null, minutes: null }, NOW).invalid).toBe(false);
    expect(checkPaperMeta({}, NOW).invalid).toBe(false);
    expect(checkPaperMeta({ minutes: 1 }, NOW).invalid).toBe(false);
    expect(checkPaperMeta({ minutes: 600 }, NOW).invalid).toBe(false);
  });

  it('refuses a day that does not exist, a malformed one, or one in the future', () => {
    for (const date of ['2026-02-30', '27/11/2026', '2026-1-5', 20261120, '2027-01-01'])
      expect(checkPaperMeta({ date, minutes: 30 }, NOW)).toEqual({
        payload: { date: null, minutes: 30 },
        invalid: true,
      });
  });

  it('allows today in the easternmost time zone, not later', () => {
    expect(latestToday(NOW)).toBe('2026-11-28');
    expect(checkPaperMeta({ date: '2026-11-28' }, NOW).invalid).toBe(false);
    expect(checkPaperMeta({ date: '2026-11-29' }, NOW).invalid).toBe(true);
  });

  it('wants a whole number of minutes from 1 to 600', () => {
    for (const minutes of [0, -5, 601, 12.5, '30', Number.NaN])
      expect(checkPaperMeta({ date: '2026-11-20', minutes }, NOW)).toEqual({
        payload: { date: '2026-11-20', minutes: null },
        invalid: true,
      });
  });
});
