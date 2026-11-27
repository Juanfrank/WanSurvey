import i18next from 'i18next';

/** Dates, times and numbers in the interface language (not the browser's). */
const lang = () => i18next.resolvedLanguage ?? i18next.language ?? 'es';

export const dateTime = (d: string | number | Date) =>
  new Date(d).toLocaleString(lang(), { dateStyle: 'short', timeStyle: 'short' });

/**
 * A moment written out in full, in a given time zone: «jueves, 26 de noviembre de 2026, 20:24».
 * Next to a native date or time picker, whose format follows the browser's locale (11/26/2026,
 * 08:24 PM in an English browser) rather than the interface language, so the day, the month
 * and the hour are never in doubt.
 */
export const dateTimeFull = (d: string | number | Date, timeZone?: string) =>
  new Date(d).toLocaleString(lang(), { dateStyle: 'full', timeStyle: 'short', timeZone });

export const timeOnly = (d: string | number | Date) =>
  new Date(d).toLocaleTimeString(lang(), { timeStyle: 'short' });

export const number = (n: number, digits = 0) =>
  n.toLocaleString(lang(), { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** A file size in the interface language: 12,3 KB / 1.5 MB. */
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 1)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
}
