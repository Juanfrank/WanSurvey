import i18next from 'i18next';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateTimeFull } from '../src/format.js';

describe('dateTimeFull', () => {
  beforeAll(async () => {
    await i18next.init({ lng: 'es', resources: {} });
  });
  afterAll(async () => {
    await i18next.changeLanguage('en');
  });

  it('writes the moment out in the interface language and the given zone', async () => {
    const at = '2026-11-27T01:24:00Z';
    await i18next.changeLanguage('es');
    expect(dateTimeFull(at, 'America/Lima')).toBe('jueves, 26 de noviembre de 2026, 20:24');
    await i18next.changeLanguage('en');
    expect(dateTimeFull(at, 'America/Lima')).toMatch(/^Thursday, November 26, 2026 at 8:24\sPM$/);
  });
});
