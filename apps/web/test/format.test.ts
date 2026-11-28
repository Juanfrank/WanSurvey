import i18next from 'i18next';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chosenFormatLocale,
  dateOnly,
  dateTime,
  dateTimeFull,
  fileSize,
  locale,
  number,
  setFormatLocale,
  timeOnly,
  wordsLocale,
} from '../src/format.js';

beforeAll(async () => {
  await i18next.init({ lng: 'es', resources: {} });
});
afterAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => setFormatLocale(null));

/** A moment in the zone of the test run, so its figures are the ones written. */
const at = new Date(2026, 11, 31, 14, 5);

describe('dateTimeFull', () => {
  it('writes the moment out in the interface language and the given zone', async () => {
    const at = '2026-11-27T01:24:00Z';
    await i18next.changeLanguage('es');
    expect(dateTimeFull(at, 'America/Lima')).toBe('jueves, 26 de noviembre de 2026, 20:24');
    await i18next.changeLanguage('en');
    expect(dateTimeFull(at, 'America/Lima')).toMatch(/^Thursday, November 26, 2026 at 8:24\sPM$/);
  });

  it('keeps the words of the interface language with the clock of the regional format', async () => {
    const at = '2026-11-27T01:24:00Z';
    await i18next.changeLanguage('en');
    setFormatLocale('es-ES');
    // English words, 24 hours and the day before the month, as in Spain.
    expect(dateTimeFull(at, 'America/Lima')).toBe('Thursday, 26 November 2026 at 20:24');
    await i18next.changeLanguage('es');
    setFormatLocale('en-US');
    expect(dateTimeFull(at, 'America/Lima')).toMatch(
      /^jueves, 26 de noviembre de 2026, 8:24\sp\.\s?m\.$/,
    );
  });
});

describe('regional format', () => {
  it('follows the interface language when none is chosen, as before', async () => {
    await i18next.changeLanguage('es');
    expect(chosenFormatLocale()).toBeNull();
    expect(locale()).toBe('es');
    expect(dateTime(at)).toBe('31/12/26, 14:05');
    expect(number(1234567.891, 2)).toBe('1.234.567,89');
    await i18next.changeLanguage('en');
    expect(dateTime(at)).toMatch(/^12\/31\/26, 2:05\sPM$/);
    expect(number(1234567.891, 2)).toBe('1,234,567.89');
  });

  it('writes figures in the chosen format whatever the interface language', async () => {
    await i18next.changeLanguage('es');
    setFormatLocale('en-US');
    expect(locale()).toBe('en-US');
    expect(dateTime(at)).toMatch(/^12\/31\/26, 2:05\sPM$/);
    expect(dateOnly(at)).toBe('12/31/26');
    expect(timeOnly(at)).toMatch(/^2:05\sPM$/);
    expect(number(1234567.891, 2)).toBe('1,234,567.89');
    expect(fileSize(1536)).toBe('1.5 KB');

    await i18next.changeLanguage('en');
    setFormatLocale('en-GB');
    expect(dateTime(at)).toBe('31/12/2026, 14:05');
    expect(timeOnly(at)).toBe('14:05');

    setFormatLocale('pt-BR');
    expect(number(1234567.891, 2)).toBe('1.234.567,89');
    expect(fileSize(1536)).toBe('1,5 KB');
  });

  it('takes a language for pages that follow another one (the respondent’s)', () => {
    expect(locale('fr')).toBe('fr');
    setFormatLocale('es-PE');
    expect(locale('fr')).toBe('es-PE');
  });

  it('gives dates with words the interface language, with the region and clock of the format', async () => {
    await i18next.changeLanguage('en');
    expect(wordsLocale()).toBe('en');
    setFormatLocale('en-GB');
    expect(wordsLocale()).toBe('en-GB');
    setFormatLocale('es-ES');
    expect(wordsLocale()).toBe('en-ES-u-hc-h23');
    setFormatLocale('');
    expect(chosenFormatLocale()).toBeNull();
  });
});
