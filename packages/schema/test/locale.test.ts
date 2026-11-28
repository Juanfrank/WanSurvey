import { describe, expect, it } from 'vitest';
import { canonicalLocale, FORMAT_LOCALES, FormatLocale } from '../src/locale.js';

describe('regional format', () => {
  it('offers only locales the runtime writes, in their canonical spelling', () => {
    for (const l of FORMAT_LOCALES) expect(canonicalLocale(l)).toBe(l);
  });

  it('keeps a locale canonical, and refuses what is not one', () => {
    expect(FormatLocale.parse('es-pe')).toBe('es-PE');
    expect(FormatLocale.parse('EN-gb')).toBe('en-GB');
    for (const bad of [
      '',
      'english',
      'es_PE',
      'xx-YY',
      'es-PE;x',
      'a'.repeat(40),
      'ar-EG',
      'sv-SE',
    ])
      expect(FormatLocale.safeParse(bad).success, bad).toBe(false);
  });
});
