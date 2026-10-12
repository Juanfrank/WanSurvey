import { allTypes, household } from '@wansurvey/fixtures';
import { Questionnaire } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import {
  applyTexts,
  extractTexts,
  parseCsv,
  textsFromCsv,
  textsFromXliff,
  textsToCsv,
  textsToXliff,
} from '../src/index.js';

const hh = () => Questionnaire.parse(household);
/** The Spanish questionnaire with English added as a language, untranslated so far. */
const withEnglish = () => ({ ...hh(), languages: ['es', 'en'] });

describe('translations', () => {
  it('lists every text with a stable, unique key', () => {
    const entries = extractTexts(hh());
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('title');
    expect(keys.some((k) => /\.option\./.test(k))).toBe(true);
    expect(keys).toContain('special.DK');
    const all = extractTexts(Questionnaire.parse(allTypes)).map((e) => e.key);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('Q_GRID.row.water');
  });

  it('applies texts, never erasing, and reports unknown keys and languages', () => {
    // The questionnaire is in Spanish; English has been added and is being translated.
    const q = withEnglish();
    const first = extractTexts(q).find((e) => e.key.endsWith('.text'))!;
    const r = applyTexts(q, [
      { key: first.key, texts: { en: 'New wording', es: '' } },
      { key: 'GONE.text', texts: { es: 'x' } },
      { key: 'title', texts: { fr: 'Titre' } },
    ]);
    expect(r.changes).toEqual([{ key: first.key, lang: 'en', from: '', to: 'New wording' }]);
    expect(extractTexts(r.questionnaire).find((e) => e.key === first.key)!.texts).toEqual({
      ...first.texts,
      en: 'New wording',
    });
    expect(r.unknownKeys).toEqual(['GONE.text']);
    expect(r.ignoredLanguages).toEqual(['fr']);
    // Every other text still lacks its English version.
    expect(r.missing.every((m) => m.lang === 'en')).toBe(true);
    // The input is untouched.
    expect(extractTexts(q).find((e) => e.key === first.key)!.texts.en).toBeUndefined();
  });

  it('reports texts still missing in a language', () => {
    const q = hh();
    const key = extractTexts(q).find((e) => e.key.endsWith('.text'))!.key;
    const blanked = applyTexts(q, []).questionnaire;
    const entry = extractTexts(blanked).find((e) => e.key === key)!;
    const node = entry.path.reduce<unknown>(
      (o, k) => (o as Record<string | number, unknown>)[k],
      blanked,
    ) as Record<string, string>;
    delete node.es;
    expect(applyTexts(blanked, []).missing).toEqual([{ key, lang: 'es' }]);
  });

  it('round-trips through CSV, including commas, quotes and line breaks', () => {
    const q = withEnglish();
    const tricky = 'Say "yes", then\nwait';
    const key = extractTexts(q)[1]!.key;
    const edited = applyTexts(q, [{ key, texts: { en: tricky } }]).questionnaire;
    const csv = textsToCsv(edited);
    expect(csv.startsWith('\uFEFFkey,context,es,en')).toBe(true);
    const rows = textsFromCsv(csv);
    expect(rows.find((r) => r.key === key)!.texts.en).toBe(tricky);
    const back = applyTexts(q, rows);
    expect(back.unknownKeys).toEqual([]);
    expect(extractTexts(back.questionnaire)).toEqual(extractTexts(edited));
    expect(parseCsv('a;b\n"x;y";2\n')).toEqual([
      ['a', 'b'],
      ['x;y', '2'],
    ]);
    expect(() => textsFromCsv('id,en\n1,x')).toThrow(/key/);
  });

  it('round-trips through XLIFF 2.0', () => {
    const q = withEnglish();
    const xml = textsToXliff(q, 'es', 'en');
    expect(xml).toContain('srcLang="es" trgLang="en"');
    expect(xml).toContain('<note>Questionnaire title</note>');
    expect(xml).toContain('<source>Encuesta de hogares</source>');
    // A translator fills in the target for the title.
    const translated = xml.replace(
      /(<unit id="title">[\s\S]*?<\/source>)/,
      '$1<target>Household &amp; survey</target>',
    );
    const { trgLang, rows } = textsFromXliff(translated);
    expect(trgLang).toBe('en');
    const r = applyTexts(q, rows);
    expect(r.changes).toEqual([{ key: 'title', lang: 'en', from: '', to: 'Household & survey' }]);
    expect(() => textsFromXliff('<xliff version="1.2"></xliff>')).toThrow(/XLIFF 2/);
  });
});
