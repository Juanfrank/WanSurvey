import { describe, expect, it } from 'vitest';
import { paperMetaProblems } from '../src/papi/PaperMeta.js';
import { typedValue } from '../src/papi/PaperTab.js';

describe('the date and duration on a paper form', () => {
  const today = '2026-11-27';
  it('are optional', () => {
    expect(paperMetaProblems('', '', today)).toEqual({});
  });
  it('take a date up to today and 1 to 600 whole minutes', () => {
    expect(paperMetaProblems('2026-11-27', '25', today)).toEqual({});
    expect(paperMetaProblems('2026-11-28', '25', today)).toEqual({ date: 'future' });
    expect(paperMetaProblems('2026-13-40', '', today)).toEqual({ date: 'invalid' });
    expect(paperMetaProblems('2026-02-30', '', today)).toEqual({ date: 'invalid' });
    for (const m of ['0', '601', '2.5', '-3'])
      expect(paperMetaProblems('', m, today)).toEqual({ minutes: 'range' });
    expect(paperMetaProblems('', '600', today)).toEqual({});
  });
});

describe('a value typed when both entries are wrong', () => {
  it('is kept as the question holds it', () => {
    expect(typedValue(' 40 ', { firstValue: 41, secondValue: 14 })).toBe(40);
    expect(typedValue('40', { firstValue: 'a', secondValue: 'b' })).toBe('40');
    expect(typedValue('1, 3', { firstValue: [1], secondValue: [1, 2] })).toEqual([1, 3]);
    expect(typedValue('2,5', { firstValue: 2, secondValue: 3 })).toBe(2.5);
    expect(typedValue('abc', { firstValue: 2, secondValue: 3 })).toBeUndefined();
    expect(typedValue('  ', { firstValue: 1, secondValue: 2 })).toBeUndefined();
  });
});
