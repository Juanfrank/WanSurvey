import { describe, expect, it } from 'vitest';
import { fromRows, toRows } from '../src/conditionModel.js';
import { breakingChanges, validateMapping } from '../src/diff.js';
import { printExpr } from '../src/print.js';
import { parse } from '../src/parser.js';
import { en, num, q, single } from './builders.js';

describe('printExpr', () => {
  it.each([
    ['a - (b - c)', 'a - (b - c)'],
    ['(a - b) - c', 'a - b - c'],
    ['(a ^ b) ^ c', '(a ^ b) ^ c'],
    ['a ^ (b ^ c)', 'a ^ b ^ c'],
    ['(-a) ^ 2', '(-a) ^ 2'],
    ['not (a == 1)', 'not a == 1'],
    ['(not a) == 1', '(not a) == 1'],
    ['(a or b) and c', '(a or b) and c'],
    ['a or (b and c)', 'a or b and c'],
    ['x not in (1, 2)', 'x not in (1, 2)'],
    ["s == 'it'", 's == "it"'],
    ['s == "a\\"b"', 's == "a\\"b"'],
    ['(a + 1).x', '(a + 1).x'],
  ])('%s → %s', (src, out) => {
    expect(printExpr(parse(src))).toBe(out);
  });
});

describe('condition rows', () => {
  it.each([
    'Q1 == 2',
    'Q1 != "x"',
    'Q2 >= 18 and Q2 < 65',
    'Q1 in (1, 2) or Q3 not in (4)',
    'Q2 between 1 and 10',
    'answered(Q1) and not answered(Q2)',
    'contains(Q4, 3)',
    'isDK(Q2) or isRefused(Q2)',
    'case.region == 1',
    'Q2 > -5',
  ])('round-trips %s', (src) => {
    const rows = toRows(src);
    expect(rows).not.toBeNull();
    expect(fromRows(rows!)).toBe(printExpr(parse(src)));
  });

  it('reads reversed comparisons the natural way', () => {
    expect(toRows('18 <= Q2')).toEqual({
      join: 'all',
      rows: [{ left: 'Q2', op: '>=', values: [18] }],
    });
  });

  it.each([
    'Q1 == 1 and (Q2 == 1 or Q3 == 1)',
    'Q2 + 1 > 3',
    'count(Q4, 1) > 0',
    'Q1 == Q2',
    'Q1 ==',
  ])('falls back to the expression editor for %s', (src) => {
    expect(toRows(src)).toBeNull();
  });

  it('ignores incomplete rows and prints nothing for none', () => {
    expect(
      fromRows({
        join: 'any',
        rows: [
          { left: 'Q1', op: '==', values: [] },
          { left: 'Q2', op: 'answered', values: [] },
        ],
      }),
    ).toBe('answered(Q2)');
    expect(fromRows({ join: 'all', rows: [] })).toBe('');
  });
});

describe('breaking changes', () => {
  const v1 = q([
    single('A'),
    num('B'),
    single('C'),
    {
      kind: 'question',
      id: 'G',
      name: 'G',
      type: 'grid',
      text: en('G'),
      rows: [
        { code: 'r1', label: en('R1') },
        { code: 'r2', label: en('R2') },
      ],
      options: [{ code: 1, label: en('Yes') }],
    } as never,
  ]);

  it('finds nothing for additions', () => {
    const v2 = q([
      single('A', {
        options: [
          { code: 1, label: en('One') },
          { code: 2, label: en('Two') },
          { code: 3, label: en('Three') },
        ],
      }),
      num('B'),
      single('C'),
      v1.sections[0]!.items[3]!,
      num('NEW'),
    ]);
    expect(breakingChanges(v1, v2)).toEqual([]);
  });

  it('lists removed variables, type changes, removed codes and grid rows', () => {
    const v2 = q([
      single('A', { options: [{ code: 1, label: en('One') }] }),
      single('B'),
      num('C2'),
      { ...v1.sections[0]!.items[3]!, rows: [{ code: 'r1', label: en('R1') }] } as never,
    ]);
    const changes = breakingChanges(v1, v2);
    expect(changes.map((c) => c.id).sort()).toEqual(
      ['codes:A', 'gridRows:G', 'removed:C', 'type:B'].sort(),
    );
    expect(changes.find((c) => c.id === 'codes:A')!.removedCodes).toEqual([2]);

    expect(validateMapping(changes, undefined, v1, v2)).toHaveLength(4);
    const problems = validateMapping(
      changes,
      {
        'codes:A': { action: 'recode', map: { '2': 1 } },
        'type:B': { action: 'drop' },
        'removed:C': { action: 'rename', to: 'C2' },
        'gridRows:G': { action: 'drop' },
      },
      v1,
      v2,
    );
    // C was coded, C2 is numeric.
    expect(problems.map((p) => p.changeId)).toEqual(['removed:C']);
  });

  it('validates rename targets and recode tables', () => {
    const v2 = q([
      single('A', { options: [{ code: 1, label: en('One') }] }),
      num('B'),
      single('C3'),
    ]);
    const changes = breakingChanges(v1, v2);
    const ok = validateMapping(
      changes,
      {
        'codes:A': { action: 'recode', map: { '2': null } },
        'removed:C': { action: 'rename', to: 'C3' },
        'removed:G': { action: 'drop' },
      },
      v1,
      v2,
    );
    expect(ok).toEqual([]);
    const bad = validateMapping(
      changes,
      {
        'codes:A': { action: 'recode', map: { '2': 9 } },
        'removed:C': { action: 'rename', to: 'B' },
        'removed:G': { action: 'recode', map: {} },
        'removed:X': { action: 'drop' },
      },
      v1,
      v2,
    );
    expect(bad.map((p) => p.changeId).sort()).toEqual(
      ['codes:A', 'removed:C', 'removed:G', 'removed:X'].sort(),
    );
  });
});
