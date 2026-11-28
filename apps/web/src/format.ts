import i18next from 'i18next';

/**
 * Dates, times and numbers in the organisation's regional format (a BCP 47 locale such as
 * es-PE or en-GB: decimal and thousands separators, day before or after the month, 24 or 12
 * hours), apart from the interface language. With none chosen they follow the interface
 * language (not the browser's), as they always did.
 */
const lang = () => i18next.resolvedLanguage ?? i18next.language ?? 'es';

let regional: string | null = null;

/** The organisation's regional format, from the session (AppLayout); null: none. */
export function setFormatLocale(locale: string | null | undefined) {
  regional = locale || null;
}

/** The chosen regional format, or null when dates and numbers follow the language. */
export const chosenFormatLocale = () => regional;

/**
 * The locale numbers and dates written in figures (31/12/2026, 14:05, 1.234,5) are written in;
 * `ui`, the language they follow when no format is chosen (the interface's by default).
 */
export const locale = (ui: string = lang()) => regional ?? ui;

/**
 * The locale of dates written with words (jueves, 26 de noviembre): the interface language,
 * with the region and the clock (24 or 12 hours) of the regional format. Month and day names
 * stay in the language people read; the regional format alone would put them in its own.
 */
export function wordsLocale(ui: string = lang()): string {
  if (!regional) return ui;
  try {
    const r = new Intl.Locale(regional);
    if (r.language === new Intl.Locale(ui).language) return regional;
    const { hourCycle } = new Intl.DateTimeFormat(regional, { hour: 'numeric' }).resolvedOptions();
    return new Intl.Locale(ui, {
      ...(r.region ? { region: r.region } : {}),
      ...(hourCycle ? { hourCycle } : {}),
    }).toString();
  } catch {
    return ui;
  }
}

export const dateTime = (d: string | number | Date) =>
  new Date(d).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });

/** A day in figures: 31/12/2026 (es-PE), 12/31/2026 (en-US). */
export const dateOnly = (d: string | number | Date, timeZone?: string) =>
  new Date(d).toLocaleDateString(locale(), { dateStyle: 'short', timeZone });

/**
 * A moment written out in full, in a given time zone: «jueves, 26 de noviembre de 2026, 20:24».
 * Next to a native date or time picker, whose format follows the browser's locale (11/26/2026,
 * 08:24 PM in an English browser) rather than the interface language, so the day, the month
 * and the hour are never in doubt.
 */
export const dateTimeFull = (d: string | number | Date, timeZone?: string) =>
  new Date(d).toLocaleString(wordsLocale(), { dateStyle: 'full', timeStyle: 'short', timeZone });

export const timeOnly = (d: string | number | Date) =>
  new Date(d).toLocaleTimeString(locale(), { timeStyle: 'short' });

export const number = (n: number, digits = 0) =>
  n.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** A file size in the regional format: 12,3 KB / 1.5 MB. */
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 1)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
}
