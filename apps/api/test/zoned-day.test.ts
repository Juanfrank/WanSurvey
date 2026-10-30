import { describe, expect, it } from 'vitest';
import { dayBounds, dayStart, localDay, nextDay, offsetMinutes } from '../src/stats/zoned-day.js';

/** The local days of a project's time zone as UTC instants (statistics on SQL Server use them). */
describe('zoned days', () => {
  const at = (s: string) => Date.parse(s);

  it('reads a zone’s offset, with daylight saving', () => {
    expect(offsetMinutes('America/Guatemala', at('2026-11-02T12:00:00Z'))).toBe(-360);
    expect(offsetMinutes('Europe/Madrid', at('2026-07-01T12:00:00Z'))).toBe(120);
    expect(offsetMinutes('Europe/Madrid', at('2026-12-01T12:00:00Z'))).toBe(60);
    expect(offsetMinutes('Asia/Kolkata', at('2026-11-02T12:00:00Z'))).toBe(330);
    expect(offsetMinutes('UTC', at('2026-11-02T12:00:00Z'))).toBe(0);
  });

  it('starts a local day at the right instant', () => {
    expect(dayStart('2026-11-02', 'America/Guatemala').toISOString()).toBe(
      '2026-11-02T06:00:00.000Z',
    );
    expect(dayStart('2026-11-02', 'Asia/Kolkata').toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(dayStart('2026-07-01', 'Europe/Madrid').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(dayStart('2026-11-02', 'UTC').toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('measures days of 23 and 25 hours when the clocks change', () => {
    const hours = (day: string) => {
      const b = dayBounds(day, 'Europe/Madrid');
      return (b.to.getTime() - b.from.getTime()) / 3_600_000;
    };
    expect(hours('2026-03-29')).toBe(23);
    expect(hours('2026-10-25')).toBe(25);
    expect(hours('2026-06-10')).toBe(24);
    expect(dayBounds('2026-03-29', 'Europe/Madrid').to.getTime()).toBe(
      dayStart('2026-03-30', 'Europe/Madrid').getTime(),
    );
  });

  it('names the local day of an instant, either side of midnight', () => {
    expect(localDay(new Date('2026-11-02T05:59:59Z'), 'America/Guatemala')).toBe('2026-11-01');
    expect(localDay(new Date('2026-11-02T06:00:00Z'), 'America/Guatemala')).toBe('2026-11-02');
    expect(localDay(new Date('2026-11-02T23:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-03');
  });

  it('steps from one day to the next across months and years', () => {
    expect(nextDay('2026-02-28')).toBe('2026-03-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});
