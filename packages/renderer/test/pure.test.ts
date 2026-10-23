import { describe, expect, it } from 'vitest';
import { parse } from '@wansurvey/logic';
import { describeCondition, printExpr, type DescribeContext } from '../src/describe.js';
import { matchTypedCode } from '../src/keyboard.js';
import { paperText } from '../src/PaperForm.js';
import { scaleColor } from '../src/scaleColors.js';

describe('typed codes', () => {
  it('selects at once when no longer code could follow, waits otherwise', () => {
    expect(matchTypedCode('2', [1, 2, 3])).toEqual({ code: 2, wait: false });
    expect(matchTypedCode('1', [1, 2, 10, 11])).toEqual({ code: 1, wait: true });
    expect(matchTypedCode('11', [1, 2, 10, 11])).toEqual({ code: 11, wait: false });
    expect(matchTypedCode('9', [10, 99])).toEqual({ code: null, wait: true });
    expect(matchTypedCode('7', [1, 2])).toEqual({ code: null, wait: false });
  });
});

describe('paper conditions', () => {
  const labels: Record<string, Record<string, string>> = { MAR: { '1': 'Married', '2': 'Single' } };
  const phrases: Record<string, string> = {
    'paper.is': '{{q}} is {{value}}',
    'paper.isNot': '{{q}} is not {{value}}',
    'paper.compare': '{{q}} {{op}} {{value}}',
    'paper.oneOf': '{{q}} is one of {{values}}',
    'paper.notOneOf': '{{q}} is not one of {{values}}',
    'paper.between': '{{q}} is between {{low}} and {{high}}',
    'paper.includes': '{{q}} includes {{value}}',
    'paper.answered': '{{q}} is answered',
    'paper.notAnswered': '{{q}} is not answered',
    'paper.and': '{{a}} and {{b}}',
    'paper.or': '{{a}} or {{b}}',
    'paper.not': 'not ({{a}})',
    'paper.caseField': 'sample field "{{name}}"',
  };
  const ctx: DescribeContext = {
    ref: (n) => ({ MAR: 'Q4', AGE: 'Q2', APPL: 'Q9' })[n] ?? n,
    label: (n, c) => labels[n]?.[String(c)] ?? null,
    t: (k, v) => phrases[k]!.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => v[name] ?? ''),
  };
  const d = (src: string) => describeCondition(parse(src), ctx);

  it('phrases common conditions with labels and paper numbers', () => {
    expect(d('MAR == 1')).toBe('Q4 is “Married” (1)');
    expect(d('MAR != 1')).toBe('Q4 is not “Married” (1)');
    expect(d('AGE < 18')).toBe('Q2 < 18');
    expect(d('18 <= AGE')).toBe('Q2 ≥ 18');
    expect(d('MAR in (1, 2)')).toBe('Q4 is one of “Married” (1), “Single” (2)');
    expect(d('AGE between 5 and 25')).toBe('Q2 is between 5 and 25');
    expect(d('contains(APPL, 2)')).toBe('Q9 includes 2');
    expect(d('answered(AGE) and not MAR == 2')).toBe('Q2 is answered and not (Q4 is “Single” (2))');
    expect(d('case.region == 3')).toBe('sample field "region" is 3');
    expect(d('AGE == null')).toBe('Q2 is not answered');
  });

  it('falls back to the expression when there is no plain form', () => {
    expect(d('sum(HH.INCOME) > 1000')).toBe('sum(HH.INCOME) > 1000');
    expect(printExpr(parse('a + b * 2'))).toBe('a + b * 2');
  });

  it('prints answers not known yet as a line to fill on paper', () => {
    expect(paperText('How old is {{M_NAME}}?')).toBe('How old is ________?');
    expect(paperText('Name of {{#if A3 == 1}}your wife{{else}}your husband{{/if}}')).toBe(
      'Name of [your wife / your husband]',
    );
    expect(paperText('{{roster.HH[i].NAME}} {{Q7 | label}}')).toBe('________ ________');
  });
});

describe('scale colours', () => {
  const lum = (hsl: string) => {
    const [h, sat, l] = hsl.match(/[\d.]+/g)!.map(Number) as [number, number, number];
    const a = (sat / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
  };
  const hex = (x: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  it('writes the chosen point in a colour that reads on its fill (4.5:1)', () => {
    for (const palette of ['nps', 'diverging', 'sequential'] as const)
      for (let n = 0; n <= 10; n++) {
        const c = scaleColor(palette, n, 0, 10)!;
        const [x, y] = [lum(c.fill), hex(c.ink)].sort((p, q) => q - p);
        expect((x! + 0.05) / (y! + 0.05), `${palette} ${n}`).toBeGreaterThanOrEqual(4.5);
      }
  });
});
