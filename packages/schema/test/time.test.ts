import { describe, expect, it } from 'vitest';
import { isTimeZone, localMinutes, utcToZoned, withinHours, zonedToUtc } from '../src/index.js';

describe('time zones', () => {
  it('knows time zones and local hours', () => {
    expect(isTimeZone('America/Lima')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    const at = new Date('2026-10-12T14:30:00Z'); // 09:30 in Lima (UTC-5)
    expect(localMinutes(at, 'America/Lima')).toBe(9 * 60 + 30);
    expect(withinHours(at, 'America/Lima', { from: '09:00', to: '21:00' })).toBe(true);
    expect(withinHours(at, 'Asia/Tokyo', { from: '09:00', to: '21:00' })).toBe(false); // 23:30
    expect(withinHours(at, 'Asia/Tokyo', { from: '00:00', to: '00:00' })).toBe(true); // all day
    expect(withinHours(at, 'Asia/Tokyo', { from: '22:00', to: '02:00' })).toBe(true);
  });

  it('converts a respondent-local time to an instant and back, across daylight saving', () => {
    expect(zonedToUtc('2026-10-12T18:00', 'America/Lima').toISOString()).toBe(
      '2026-10-12T23:00:00.000Z',
    );
    // Madrid changes to winter time on 25 October 2026.
    expect(zonedToUtc('2026-10-24T10:00', 'Europe/Madrid').toISOString()).toBe(
      '2026-10-24T08:00:00.000Z',
    );
    expect(zonedToUtc('2026-10-26T10:00', 'Europe/Madrid').toISOString()).toBe(
      '2026-10-26T09:00:00.000Z',
    );
    expect(utcToZoned(new Date('2026-10-12T23:00:00Z'), 'America/Lima')).toBe('2026-10-12T18:00');
  });
});
