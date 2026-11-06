import { describe, expect, it } from 'vitest';
import { regexProblem, regexTest } from '../src/safeRegex.js';

describe('safe regular expressions', () => {
  it('matches like the usual syntax', () => {
    const yes: [string, string][] = [
      ['abc', 'xxabcxx'],
      ['^abc', 'abcdef'],
      ['abc$', 'xxabc'],
      ['^a.c$', 'abc'],
      ['^[a-c]+$', 'abcabc'],
      ['^[^0-9]+$', 'sin numeros'],
      ['^\\d{3}-\\d{4}$', '555-1234'],
      ['^(ceo|gerente)', 'Gerente general'],
      ['^ab?c$', 'ac'],
      ['^(ab){2,3}$', 'ababab'],
      ['^(ab){2,}$', 'abababab'],
      ['colou?r', 'The COLOR red'],
      ['^\\w+@\\w+\\.org$', 'ana@agencia.org'],
      ['^$', ''],
      ['', 'anything'],
    ];
    for (const [p, t] of yes) expect(regexTest(p, t), `${p} on ${t}`).toBe(true);
    const no: [string, string][] = [
      ['^abc', 'xabc'],
      ['abc$', 'abcx'],
      ['^a.c$', 'abbc'],
      ['^[a-c]+$', 'abcd'],
      ['^\\d{3}-\\d{4}$', '55-1234'],
      ['^(ab){2,3}$', 'ababababab'],
      ['^ab?c$', 'abbc'],
      ['^$', 'x'],
    ];
    for (const [p, t] of no) expect(regexTest(p, t), `${p} on ${t}`).toBe(false);
  });

  it('ignores case, and reads accents as letters', () => {
    expect(regexTest('^josé$', 'JOSÉ')).toBe(true);
    expect(regexTest('^\\w+$', 'Ñandú')).toBe(true);
  });

  it('is not slowed down by patterns that make a backtracking engine take minutes', () => {
    const text = 'a'.repeat(5000) + 'b';
    const started = Date.now();
    expect(regexTest('^(a+)+$', text)).toBe(false);
    expect(regexTest('^(a|aa)+$', text)).toBe(false);
    expect(regexTest('(x+x+)+y', 'x'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says what is wrong with a pattern', () => {
    expect(regexProblem('^abc$')).toBeNull();
    expect(regexProblem('(abc')).toMatch(/never closed/);
    expect(regexProblem('abc)')).toMatch(/no \( before/);
    expect(regexProblem('[a-')).toMatch(/never closed/);
    expect(regexProblem('*a')).toMatch(/nothing to repeat/);
    expect(regexProblem('a{200}')).toMatch(/above 100/);
    expect(regexProblem('(a{100}){100}{100}')).toMatch(/too large|above/);
    expect(regexProblem('\\1')).toMatch(/not supported/);
    expect(regexProblem('x'.repeat(600))).toMatch(/too long/);
    expect(() => regexTest('(', 'x')).toThrow();
  });
});
