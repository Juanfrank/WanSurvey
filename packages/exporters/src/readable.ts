import type { Cell, Column } from './table.js';

/**
 * The organisation's regional format, for the readable exports (CSV and Excel with labels):
 * the locale (BCP 47) and the project's time zone, in which the moments are written.
 */
export interface ReadableFormat {
  locale: string;
  timeZone: string;
}

const MOMENTS = new Set(['started_at', 'submitted_at']);

/** A column holding a moment (ISO 8601 text in the data formats). */
export const isMoment = (c: Column) => c.source?.kind === 'meta' && MOMENTS.has(c.source.field);

/** The locale's decimal mark: `,` (es-ES, pt-BR) or `.` (en-US, es-PE). */
export const decimalMark = (locale: string) =>
  new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';

/**
 * The field separator of a readable CSV: `;` where the decimal mark is a comma, as spreadsheets
 * set to those locales expect (and so a number's comma never splits a cell), `,` elsewhere.
 */
export const csvSeparator = (locale: string) => (decimalMark(locale) === ',' ? ';' : ',');

/**
 * The cells of a readable CSV row: moments as the locale writes them, in the project's time
 * zone, the day and the time apart (31/12/26 14:05:09, 12/31/26 2:05:09 PM) with plain spaces
 * so spreadsheets read them as dates, and numbers with the locale's decimal mark. Numbers get
 * no thousands separator, so a code or a year reads as it is; coded answers are left for their
 * labels.
 */
export function readableRow(columns: Column[], fmt: ReadableFormat): (row: Cell[]) => Cell[] {
  const day = new Intl.DateTimeFormat(fmt.locale, { dateStyle: 'short', timeZone: fmt.timeZone });
  const time = new Intl.DateTimeFormat(fmt.locale, { timeStyle: 'medium', timeZone: fmt.timeZone });
  const number = new Intl.NumberFormat(fmt.locale, {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
  const kinds = columns.map((c) => (isMoment(c) ? 'moment' : c.type === 'numeric' ? 'number' : ''));
  return (row) =>
    row.map((cell, i) => {
      const kind = kinds[i];
      if (kind === 'moment' && typeof cell === 'string') {
        const d = new Date(cell);
        return Number.isNaN(d.getTime()) ? cell : plain(`${day.format(d)} ${time.format(d)}`);
      }
      if (kind === 'number' && typeof cell === 'number' && !columns[i]!.valueLabels?.has(cell))
        return number.format(cell);
      return cell;
    });
}

const SAMPLE = new Date(Date.UTC(2026, 11, 31, 14, 5, 9));

/**
 * An Excel number format for a moment written the locale's way: `dd/mm/yyyy hh:mm:ss` for
 * es-PE, `mm/dd/yyyy, hh:mm:ss AM/PM` for en-US. The cell stays a date Excel can sort and
 * compute with.
 */
export function excelMomentFormat(locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  }).formatToParts(SAMPLE);
  const tokens: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {
    year: 'yyyy',
    month: 'mm',
    day: 'dd',
    hour: 'hh',
    minute: 'mm',
    second: 'ss',
    dayPeriod: 'AM/PM',
  };
  return parts
    .map((p) =>
      p.type === 'literal'
        ? // Separators Excel reads as they are; anything else is quoted.
          [...p.value]
            .map((ch) => (/[/\-: ]/.test(ch) ? ch : /\s/.test(ch) ? ' ' : `\\${ch}`))
            .join('')
        : (tokens[p.type] ?? ''),
    )
    .join('');
}

/**
 * Moments as Excel stores them: the wall-clock time in the project's time zone (Excel dates
 * have none), as a Date whose UTC fields are that time. Null for text that is not a moment.
 */
export function wallClock(timeZone: string): (iso: string) => Date | null {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = f.formatToParts(d);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return new Date(
      Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) +
        d.getUTCMilliseconds(),
    );
  };
}
