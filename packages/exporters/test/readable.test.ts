import { describe, expect, it } from 'vitest';
import { writeCsv } from '../src/csv.js';
import { excelMomentFormat, readableRow, wallClock } from '../src/readable.js';
import type { Column, Table } from '../src/table.js';

const columns: Column[] = [
  {
    name: 'started_at',
    label: 'Started',
    type: 'string',
    source: { kind: 'meta', field: 'started_at' },
  },
  { name: 'AGE', label: 'Age', type: 'numeric' },
  {
    name: 'WORK',
    label: 'Works',
    type: 'numeric',
    valueLabels: new Map([
      [1, 'Yes'],
      [2, 'No'],
    ]),
  },
  { name: 'NOTE', label: 'Note', type: 'string' },
];
const table: Table = {
  name: 'data',
  columns,
  rows: [['2026-12-31T19:05:09.000Z', -1234.5, 1, '2026-12-31T19:05:09.000Z']],
};
const lima = 'America/Lima';

describe('readable exports in the regional format', () => {
  it('writes moments in the project’s zone and numbers with the locale’s decimal mark', () => {
    const row = readableRow(columns, { locale: 'es-ES', timeZone: lima })(table.rows[0]!);
    // A text answer that looks like a moment is an answer: left as written.
    expect(row).toEqual(['31/12/26 14:05:09', '-1234,5', 1, '2026-12-31T19:05:09.000Z']);
    expect(readableRow(columns, { locale: 'en-GB', timeZone: lima })(table.rows[0]!)[0]).toBe(
      '31/12/2026 14:05:09',
    );
    // Plain spaces, so spreadsheets read the moment as one (not U+202F before PM).
    expect(readableRow(columns, { locale: 'en-US', timeZone: lima })(table.rows[0]!)[0]).toBe(
      '12/31/26 2:05:09 PM',
    );
  });

  it('only in a CSV with labels: a CSV with codes is data and stays as it was', () => {
    const format = { locale: 'es-ES', timeZone: lima };
    const lines = (labels: boolean) => writeCsv(table, { labels, format }).slice(1).split('\r\n');
    // A comma for decimals: the fields are separated by semicolons, as such spreadsheets expect.
    expect(lines(true)[0]).toBe('started_at;AGE;WORK;NOTE');
    expect(lines(true)[1]).toBe('31/12/26 14:05:09;"-1234,5";Yes;2026-12-31T19:05:09.000Z');
    expect(
      writeCsv(table, { labels: true, format: { locale: 'en-GB', timeZone: lima } }),
    ).toContain('\r\n31/12/2026 14:05:09,-1234.5,Yes,');
    expect(lines(false)[1]).toBe('2026-12-31T19:05:09.000Z,-1234.5,1,2026-12-31T19:05:09.000Z');
    // Without a format, labels as before.
    expect(writeCsv(table, { labels: true }).slice(1).split('\r\n')[1]).toBe(
      '2026-12-31T19:05:09.000Z,-1234.5,Yes,2026-12-31T19:05:09.000Z',
    );
  });

  it('gives Excel a date format the locale’s way, and the wall-clock time of the zone', () => {
    expect(excelMomentFormat('es-PE')).toBe('dd/mm/yyyy\\, hh:mm:ss AM/PM');
    expect(excelMomentFormat('en-GB')).toBe('dd/mm/yyyy\\, hh:mm:ss');
    expect(excelMomentFormat('en-US')).toBe('mm/dd/yyyy\\, hh:mm:ss AM/PM');
    expect(excelMomentFormat('de-DE')).toBe('dd\\.mm\\.yyyy\\, hh:mm:ss');
    const at = wallClock(lima)('2026-12-31T19:05:09.250Z')!;
    expect(at.toISOString()).toBe('2026-12-31T14:05:09.250Z');
    expect(wallClock(lima)('not a date')).toBeNull();
  });
});
