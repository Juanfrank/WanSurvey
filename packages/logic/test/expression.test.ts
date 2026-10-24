import { describe, expect, it } from 'vitest';
import { evaluate, evaluateCondition } from '../src/evaluator.js';
import { LogicSyntaxError } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { mapScope } from './helpers.js';
import type { Value } from '../src/values.js';

const ev = (
  src: string,
  vars: Record<string, Value> = {},
  opts: Parameters<typeof mapScope>[1] = {},
) => evaluate(parse(src), mapScope(vars, opts));

describe('parser', () => {
  it('respects precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('2 ^ 3 ^ 2')).toBe(512); // right associative
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('10 % 4')).toBe(2);
    expect(ev('1 < 2 and 2 < 3 or false')).toBe(true);
    expect(ev('not 1 == 2')).toBe(true);
  });

  it('parses in, not in and between', () => {
    expect(ev('Q in (1, 2)', { Q: 2 })).toBe(true);
    expect(ev('Q not in (1, 2)', { Q: 3 })).toBe(true);
    expect(ev('Q between 1 and 5', { Q: 5 })).toBe(true);
    expect(ev('Q between 1 and 5 and true', { Q: 6 })).toBe(false);
  });

  it('accepts operator aliases', () => {
    expect(ev('1 = 1 && 2 <> 3 || !true')).toBe(true);
  });

  it('reports syntax errors with positions', () => {
    expect(() => parse('1 +')).toThrow(LogicSyntaxError);
    expect(() => parse('Q in ()')).toThrow(/at least one/);
    expect(() => parse('1 < 2 < 3')).toThrow(/chained/);
    try {
      parse('Q5 @ 3');
    } catch (e) {
      expect((e as LogicSyntaxError).span.start).toBe(3);
    }
  });

  it('never uses eval', () => {
    // An attempt at code injection is just an unknown identifier / syntax error.
    expect(() => parse('constructor.constructor("return 1")()')).toThrow(LogicSyntaxError);
    expect(ev('constructor')).toBe(null);
  });

  it('rejects very deep nesting with a syntax error, not a stack overflow', () => {
    const deep = (n: number, open: string, close = '') => `${open.repeat(n)}1${close.repeat(n)}`;
    expect(ev(deep(199, '(', ')'))).toBe(1);
    for (const src of [
      deep(20000, '(', ')'),
      deep(20000, 'not '),
      deep(20000, '-'),
      `${'2 ^ '.repeat(20000)}1`,
      `${'f('.repeat(20000)}1${')'.repeat(20000)}`,
    ]) {
      expect(() => parse(src)).toThrow(LogicSyntaxError);
      expect(() => parse(src)).toThrow(/nested too deeply/);
    }
  });
});

describe('null semantics', () => {
  const ops = ['==', '!=', '<', '<=', '>', '>='];
  it.each(ops)('comparison %s with an unanswered variable is false', (op) => {
    expect(ev(`Q ${op} 1`, { Q: null })).toBe(false);
    expect(ev(`1 ${op} Q`, { Q: null })).toBe(false);
  });
  it.each(ops)('comparison %s with a DK answer is false', (op) => {
    expect(ev(`Q ${op} 1`, { Q: { $special: 'DK' } })).toBe(false);
  });
  it('in / between with null are false', () => {
    expect(ev('Q in (1)', { Q: null })).toBe(false);
    expect(ev('Q not in (1)', { Q: null })).toBe(false);
    expect(ev('Q between 1 and 2', { Q: null })).toBe(false);
  });
  it('arithmetic with null yields null and never throws', () => {
    expect(ev('Q + 1', { Q: null })).toBe(null);
    expect(ev('1 / 0')).toBe(null);
    expect(ev('5 % 0')).toBe(null);
    expect(ev('"a" * 2')).toBe(null);
    expect(ev('UNKNOWN + 1')).toBe(null);
    expect(ev('nosuchfn(1)')).toBe(null);
  });
  it('explicit null checks', () => {
    expect(ev('Q == null', { Q: null })).toBe(true);
    expect(ev('Q != null', { Q: 3 })).toBe(true);
    expect(ev('Q == null', { Q: { $special: 'RF' } })).toBe(false);
  });
  it('conditions with null are false', () => {
    expect(evaluateCondition(parse('Q'), mapScope({ Q: null }))).toBe(false);
    expect(evaluateCondition(parse('not Q'), mapScope({ Q: null }))).toBe(true);
  });
});

describe('values and scope', () => {
  it('compares codes loosely between number and string', () => {
    expect(ev('Q == 1', { Q: '1' })).toBe(true);
    expect(ev('case.region == 2', {}, { ns: { case: { region: '2' } } })).toBe(true);
  });
  it('reads namespaces and mode', () => {
    expect(ev('case.city', {}, { ns: { case: { city: 'Lima' } } })).toBe('Lima');
    expect(ev('interviewer.firstName', {}, { ns: { interviewer: { firstName: 'Ana' } } })).toBe(
      'Ana',
    );
    expect(ev('case.missing')).toBe(null);
    expect(ev('mode == "CATI"', {}, { mode: 'CATI' })).toBe(true);
  });
  it('supports numeric strings from sample data in arithmetic', () => {
    expect(ev('case.n + 1', {}, { ns: { case: { n: '41' } } })).toBe(42);
  });
  it('indexes rosters 1-based and projects columns', () => {
    const vars = {
      HH: [
        { AGE: 30, SEX: 1 },
        { AGE: 5, SEX: 2 },
        { AGE: 70, SEX: 2 },
      ],
    };
    expect(ev('HH[2].AGE', vars)).toBe(5);
    expect(ev('HH[9].AGE', vars)).toBe(null);
    expect(ev('HH.AGE', vars)).toEqual([30, 5, 70]);
    expect(ev('sum(HH.AGE)', vars)).toBe(105);
    expect(ev('count(HH.SEX, 2)', vars)).toBe(2);
  });
});

describe('functions', () => {
  const rosters = { HH: ['AGE', 'SEX'] };
  const vars: Record<string, Value> = {
    MULTI: [1, 3],
    NAME: 'Maria',
    DOB: '1990-06-15',
    HH: [{ AGE: 30 }, { AGE: 12 }],
    Q7: 2,
  };
  const s = (src: string) => ev(src, vars, { rosters, labels: { Q7: { '2': 'Rented' } } });

  it('answered / isDK / isRefused', () => {
    expect(ev('answered(Q)', { Q: null })).toBe(false);
    expect(ev('answered(Q)', { Q: '' })).toBe(false);
    expect(ev('answered(Q)', { Q: [] })).toBe(false);
    expect(ev('answered(Q)', { Q: { $special: 'DK' } })).toBe(true);
    expect(ev('isDK(Q)', { Q: { $special: 'DK' } })).toBe(true);
    expect(ev('isRefused(Q)', { Q: { $special: 'RF' } })).toBe(true);
    expect(ev('isDK(Q)', { Q: 1 })).toBe(false);
  });
  it('count / contains / length', () => {
    expect(s('count(MULTI, 3)')).toBe(1);
    expect(s('contains(MULTI, 3)')).toBe(true);
    expect(s('contains(MULTI, 2)')).toBe(false);
    expect(s('contains(NAME, "ar")')).toBe(true);
    expect(s('length(NAME)')).toBe(5);
    expect(s('length(MULTI)')).toBe(2);
    expect(s('length(NOPE)')).toBe(0);
  });
  it('sum / min / max ignore unanswered values', () => {
    expect(ev('sum(A, B, C)', { A: 1, B: null, C: 4 })).toBe(5);
    expect(ev('sum(A, B)', { A: null, B: null })).toBe(null);
    expect(ev('min(A, B, 3)', { A: 7, B: { $special: 'DK' } })).toBe(3);
    expect(ev('max(A, 3)', { A: 7 })).toBe(7);
  });
  it('dates: age, datediff, today, date', () => {
    expect(s('age(DOB)')).toBe(36);
    expect(s('age(DOB, "2026-06-14")')).toBe(35);
    expect(s('age(DOB, "2026-06-15")')).toBe(36);
    expect(s('datediff("2026-01-01", "2026-03-01")')).toBe(59);
    expect(s('datediff("2026-01-31", "2026-03-01", "months")')).toBe(1);
    expect(s('datediff("2020-02-29", "2026-02-28", "years")')).toBe(5);
    expect(s('datediff("2026-01-01T08:00:00Z", "2026-01-01T10:30:00Z", "minutes")')).toBe(150);
    expect(s('today()')).toBe('2026-10-12');
    expect(s('date("2026-02-30")')).toBe(null);
    expect(s('age("not a date")')).toBe(null);
  });
  it('date-times with impossible hours, minutes or offsets are not dates', async () => {
    const { parseIsoDate } = await import('../src/values.js');
    expect(parseIsoDate('2026-01-01T23:59:59+14:00')).not.toBeNull();
    expect(parseIsoDate('2026-01-01T10:00-05:30')).toBe(Date.UTC(2026, 0, 1, 15, 30));
    for (const bad of [
      '2026-01-01T24:00',
      '2026-01-01T99:00',
      '2026-01-01T10:60',
      '2026-01-01T10:00:61',
      '2026-01-01T10:00+15:00',
      '2026-01-01T10:00+99:99',
      '2026-01-01T10:00-05:75',
    ])
      expect(parseIsoDate(bad)).toBeNull();
  });
  it('label returns the label of the selected code', () => {
    expect(s('label(Q7)')).toBe('Rented');
  });
  it('rosterCount / any / all', () => {
    expect(s('rosterCount(HH)')).toBe(2);
    expect(s('any(HH, AGE < 18)')).toBe(true);
    expect(s('all(HH, AGE < 18)')).toBe(false);
    expect(ev('all(HH, AGE > 1)', { HH: [] }, { rosters })).toBe(true);
    expect(ev('any(HH, AGE > 1)', { HH: null }, { rosters })).toBe(false);
  });
  it('round / abs', () => {
    expect(ev('round(70 / (1.75 ^ 2), 1)')).toBe(22.9);
    expect(ev('abs(-3)')).toBe(3);
  });
  it('wrong arity yields null rather than throwing', () => {
    expect(ev('contains(1)')).toBe(null);
  });
});
