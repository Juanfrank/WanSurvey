import { allTypes } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { interpret } from '../src/papi/omr/interpret.js';
import { layoutForm, parsePageCode, type Bubble } from '../src/papi/omr/layout.js';
import { measurer, scanFormsPdf } from '../src/papi/omr/pdf.js';
import { fill, findCode, locate, rasterize } from '../src/papi/omr/read.js';
import { fillAndScan } from './support/scan.js';

const WORDS = {
  markAll: 'Mark all that apply',
  writeHere: 'write here',
  continued: 'continued',
  special: { DK: "Don't know", RF: 'Refused', NA: 'N/A' },
};

describe('machine-readable paper forms', () => {
  it('lays out a form, splits a PDF of several cases, and reads the marks back', async () => {
    const compiled = compile(Questionnaire.parse(allTypes));
    const measure = await measurer();
    const layout = layoutForm(compiled, compiled.questionnaire.defaultLanguage, WORDS, measure);
    expect(layout.pages).toBeGreaterThan(0);
    const marked = layout.questions.filter((q) => q.reading === 'marks');
    expect(marked.length).toBeGreaterThan(2);

    const pdf = await scanFormsPdf(
      layout,
      {
        title: 'All types',
        versionId: '00000000-0000-4000-8000-000000000001',
        lang: compiled.questionnaire.defaultLanguage,
        instructions: 'Fill the circle completely.',
        pageOf: (n, of) => `Page ${n} of ${of}`,
      },
      [
        { caseId: '00000000-0000-4000-8000-0000000000a1', externalId: 'A1' },
        { caseId: '00000000-0000-4000-8000-0000000000a2', externalId: 'A2' },
      ],
    );
    // Case A1: the first option of each single choice; two marks on the first multi-choice.
    const single = marked.find((q) => q.type === 'single')!;
    const multi = marked.find((q) => q.type === 'multi');
    const marks = [single.bubbles[0]!];
    if (multi) marks.push(multi.bubbles[0]!, multi.bubbles[1]!);
    // Case A2 (pages after A1's): two marks on the single choice, a conflict.
    const shifted = (b: Bubble) => ({ ...b, page: b.page + layout.pages });
    marks.push(shifted(single.bubbles[0]!), shifted(single.bubbles[1]!));
    const scan = await fillAndScan(pdf, marks, { tilt: 1.2 });

    const pages = await rasterize(scan);
    expect(pages).toHaveLength(layout.pages * 2);
    const forms = new Map<string, number[]>();
    for (const [i, img] of pages.entries()) {
      const code = findCode(img);
      expect(code, `page ${i + 1}`).not.toBeNull();
      const parsed = parsePageCode(code!.text)!;
      forms.set(parsed.caseId, [...(forms.get(parsed.caseId) ?? []), parsed.page]);
    }
    // Two forms, each with all its pages.
    expect([...forms.values()].map((p) => p.length)).toEqual([layout.pages, layout.pages]);

    const readCase = (offset: number) => {
      const fills = new Map<Bubble, number>();
      for (const q of layout.questions)
        for (const b of q.bubbles) {
          const img = pages[offset + b.page - 1]!;
          const t = locate(img, findCode(img)!)!;
          fills.set(b, fill(img, t, b));
        }
      return fills;
    };
    const a1 = readCase(0);
    expect(interpret(single, a1)).toEqual({ value: single.bubbles[0]!.code });
    if (multi)
      expect(interpret(multi, a1).value).toEqual([multi.bubbles[0]!.code, multi.bubbles[1]!.code]);
    const other = marked.find((q) => q !== single && q !== multi)!;
    expect(interpret(other, a1).issue?.kind).toBe('blank');
    const a2 = readCase(layout.pages);
    expect(interpret(single, a2).issue?.kind).toBe('multiple');
  }, 60_000);
  it('refuses a PDF with an oversized page anywhere, not only on the first', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    doc.addPage([14_000, 14_000]);
    await expect(rasterize(Buffer.from(await doc.save()))).rejects.toThrow(/larger than A3/);
    // Pages within the limit are read at the scanning resolution.
    const ok = await PDFDocument.create();
    ok.addPage([595, 842]);
    ok.addPage([842, 1190]);
    const pages = await rasterize(Buffer.from(await ok.save()));
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [1240, 1755],
      [1755, 2480],
    ]);
  });
});
