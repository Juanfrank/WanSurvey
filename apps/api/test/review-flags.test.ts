import { compile } from '@wansurvey/logic';
import { Questionnaire, ReviewSettings } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { computeFlags, inSample } from '../src/review/flags.js';

const es = (text: string) => ({ es: text });
const opts = [1, 2, 3].map((code) => ({ code, label: es(`O${code}`) }));
const compiled = compile(
  Questionnaire.parse({
    id: 'FLAGS',
    title: es('Flags'),
    defaultLanguage: 'es',
    languages: ['es'],
    answerSets: { AGREE: opts },
    sections: [
      {
        id: 'S',
        title: es('S'),
        items: [
          ...['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((id) => ({
            kind: 'question',
            id,
            name: id,
            type: 'single',
            text: es(id),
            answerSetId: 'AGREE',
          })),
          {
            kind: 'question',
            id: 'GRID',
            name: 'GRID',
            type: 'grid',
            text: es('Grid'),
            options: opts,
            rows: ['a', 'b', 'c', 'd', 'e'].map((code) => ({ code, label: es(code) })),
          },
          { kind: 'question', id: 'JOB', name: 'JOB', type: 'text', text: es('Job') },
        ],
      },
    ],
  }),
);
const settings = ReviewSettings.parse({});
const path = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'GRID', 'JOB'];

describe('review flags', () => {
  it('flags speeding from active time per answered question', () => {
    const answers = { Q1: 1, Q2: 2, Q3: 3, Q4: 1, Q5: 2, JOB: 'x' };
    expect(
      computeFlags({ compiled, answers, path, activeMs: 6 * 1000, warningsConfirmed: 0, settings })
        .speeding,
    ).toBe(1000);
    expect(
      computeFlags({ compiled, answers, path, activeMs: 6 * 5000, warningsConfirmed: 0, settings })
        .speeding,
    ).toBeUndefined();
  });

  it('flags straight-lining in a grid and in a run of questions sharing an answer set', () => {
    const answers = {
      Q1: 2,
      Q2: 2,
      Q3: 2,
      Q4: 2,
      Q5: 2,
      GRID: { a: 1, b: 1, c: 1, d: 1, e: 1 },
    };
    const f = computeFlags({
      compiled,
      answers,
      path,
      activeMs: 999_999,
      warningsConfirmed: 0,
      settings,
    });
    expect(f.straightlining).toEqual(['GRID', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
    const mixed = computeFlags({
      compiled,
      answers: { ...answers, Q3: 1, GRID: { a: 1, b: 2, c: 1, d: 1, e: 1 } },
      path,
      activeMs: 999_999,
      warningsConfirmed: 0,
      settings,
    });
    expect(mixed.straightlining).toBeUndefined();
  });

  it('counts confirmed warnings, other texts and double-entry differences', () => {
    const f = computeFlags({
      compiled,
      answers: { Q1: 1, JOB_OTHER: 'carpintero', 'HH[1].OCC_OTHER': ' ', X_OTHER: 'y' },
      path,
      activeMs: 999_999,
      warningsConfirmed: 2,
      doubleEntryDifferences: 3,
      settings,
    });
    expect(f).toEqual({ warningsOverridden: 2, otherText: 2, doubleEntry: 3 });
  });

  it('samples the same interviews every time, about the given share', () => {
    const ids = Array.from(
      { length: 2000 },
      (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const picked = ids.filter((id) => inSample(id, 10)).length;
    expect(picked).toBeGreaterThan(140);
    expect(picked).toBeLessThan(260);
    expect(ids.filter((id) => inSample(id, 10))).toEqual(ids.filter((id) => inSample(id, 10)));
    expect(inSample(ids[0]!, 0)).toBe(false);
    expect(inSample(ids[0]!, 100)).toBe(true);
  });
});
