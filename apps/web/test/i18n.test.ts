import { rendererResources } from '@wansurvey/renderer';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { registerSamplingText } from '../src/cases/sampling-i18n.js';
import { initI18n } from '../src/i18n.js';
import { TEXT } from '../src/respondent/text.js';

/** Every leaf key of a catalogue, as dotted paths. */
function keys(o: unknown, prefix = ''): string[] {
  if (typeof o !== 'object' || o === null) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

/** Keys in one catalogue and not the other, both ways. */
function difference(a: unknown, b: unknown) {
  const ka = new Set(keys(a));
  const kb = new Set(keys(b));
  return {
    onlyEnglish: [...ka].filter((k) => !kb.has(k)),
    onlySpanish: [...kb].filter((k) => !ka.has(k)),
  };
}

const NONE = { onlyEnglish: [], onlySpanish: [] };

describe('interface catalogues', () => {
  it('English and Spanish have the same keys, plural forms included', async () => {
    await initI18n('es');
    registerSamplingText();
    const app = (lng: string) => i18next.getResourceBundle(lng, 'app');
    expect(difference(app('en'), app('es'))).toEqual(NONE);
    expect(difference(rendererResources.en.renderer, rendererResources.es.renderer)).toEqual(NONE);
    expect(difference(TEXT.en, TEXT.es)).toEqual(NONE);
  });

  it('no translation is left empty', async () => {
    await initI18n('es');
    registerSamplingText();
    for (const lng of ['en', 'es']) {
      const bundle = i18next.getResourceBundle(lng, 'app') as Record<string, unknown>;
      const empty = keys(bundle).filter((k) => {
        const v = k
          .split('.')
          .reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], bundle);
        return typeof v === 'string' && v.trim() === '';
      });
      expect(empty, lng).toEqual([]);
    }
  });

  it('a placeholder used in English is used in Spanish too', async () => {
    await initI18n('es');
    registerSamplingText();
    const en = i18next.getResourceBundle('en', 'app') as Record<string, unknown>;
    const es = i18next.getResourceBundle('es', 'app') as Record<string, unknown>;
    const at = (o: Record<string, unknown>, k: string) =>
      k.split('.').reduce<unknown>((x, p) => (x as Record<string, unknown>)?.[p], o);
    const vars = (s: unknown) =>
      typeof s === 'string' ? [...s.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]).sort() : [];
    const mismatched = keys(en).filter(
      (k) => JSON.stringify(vars(at(en, k))) !== JSON.stringify(vars(at(es, k))),
    );
    expect(mismatched).toEqual([]);
  });
});
