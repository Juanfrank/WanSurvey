import { describe, expect, it } from 'vitest';
import { fromRows, toRows } from '../src/conditionModel.js';
import { breakingChanges, validateMapping } from '../src/diff.js';
import { printExpr } from '../src/print.js';
import { fromTree, toTree } from '../src/conditionTree.js';
import { describeCondition } from '../src/describe.js';
import { routingMap } from '../src/routingMap.js';
import { household } from '@wansurvey/fixtures';
import { Questionnaire } from '@wansurvey/schema';
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

  it('rejects renames into another roster level, or two variables onto one', () => {
    const roster = (items: unknown[]) =>
      ({
        kind: 'roster',
        id: 'HH',
        name: 'HH',
        title: en('HH'),
        count: { type: 'fixed', n: 2 },
        items,
      }) as never;
    const prev = q([num('AGE'), num('YEARS'), roster([num('SIZE')])]);
    const next = q([roster([num('AGE2')]), num('SIZE2')]);
    const changes = breakingChanges(prev, next);
    const msgs = (mapping: Record<string, unknown>) =>
      validateMapping(changes, mapping as never, prev, next).map((p) => p.msg.id);
    expect(
      msgs({
        'removed:AGE': { action: 'rename', to: 'AGE2' },
        'removed:YEARS': { action: 'drop' },
        'removed:SIZE': { action: 'rename', to: 'SIZE2' },
      }),
    ).toEqual(['target_roster', 'target_roster']);
    const flat = q([num('AGE2')]);
    const flatChanges = breakingChanges(prev, flat);
    expect(
      validateMapping(
        flatChanges,
        {
          'removed:AGE': { action: 'rename', to: 'AGE2' },
          'removed:YEARS': { action: 'rename', to: 'AGE2' },
          'removed:HH': { action: 'drop' },
          'removed:SIZE': { action: 'drop' },
        },
        prev,
        flat,
      ).map((p) => p.msg.id),
    ).toEqual(['target_twice']);
  });

  it('removing "other, specify" is a breaking change for its text', () => {
    const withOther = q([
      single('A', {
        options: [
          { code: 1, label: en('One') },
          { code: 9, label: en('Other'), otherSpecify: true },
        ],
      }),
    ]);
    const without = q([
      single('A', {
        options: [
          { code: 1, label: en('One') },
          { code: 9, label: en('Other') },
        ],
      }),
    ]);
    expect(breakingChanges(withOther, without).map((c) => c.id)).toEqual(['removed:A_OTHER']);
  });
});

describe('condition tree', () => {
  it.each([
    'Q1 == 1 and (Q2 == 1 or Q3 == 1)',
    '(Q1 == 1 or Q2 == 2) and not (Q3 == 1 and Q4 > 2)',
    'Q10 > Q9',
    'age(DOB) >= 18',
    'count(Q4, 1) > 0 or length(NAME) < 3',
    'DATE <= today()',
    'case.region in (1, 2) and Q2 between 18 and Q9',
    'not answered(Q1) or isDK(Q2)',
    'contains(Q4, 3)',
  ])('round-trips %s', (src) => {
    const tree = toTree(src);
    expect(tree).not.toBeNull();
    expect(fromTree(tree!)).toBe(printExpr(parse(src)));
  });

  it('nests groups and negation', () => {
    expect(toTree('A == 1 and not (B == 2 or C == 3)')).toEqual({
      type: 'group',
      join: 'all',
      items: [
        {
          type: 'row',
          left: { kind: 'var', name: 'A' },
          op: '==',
          right: [{ kind: 'value', value: 1 }],
        },
        {
          type: 'group',
          join: 'any',
          negate: true,
          items: [
            {
              type: 'row',
              left: { kind: 'var', name: 'B' },
              op: '==',
              right: [{ kind: 'value', value: 2 }],
            },
            {
              type: 'row',
              left: { kind: 'var', name: 'C' },
              op: '==',
              right: [{ kind: 'value', value: 3 }],
            },
          ],
        },
      ],
    });
  });

  it.each(['Q2 + 1 > 3', 'Q1', 'label(Q1) == "x"', 'any(HH, AGE > 18)', 'Q1 =='])(
    'leaves %s to the expression editor',
    (src) => expect(toTree(src)).toBeNull(),
  );

  it('drops incomplete rows and empty groups', () => {
    expect(
      fromTree({
        type: 'group',
        join: 'any',
        items: [
          { type: 'row', left: { kind: 'var', name: 'A' }, op: '==', right: [] },
          { type: 'group', join: 'all', items: [] },
          {
            type: 'row',
            left: { kind: 'var', name: 'B' },
            op: '>',
            right: [{ kind: 'var', name: 'C' }],
          },
        ],
      }),
    ).toBe('B > C');
  });
});

describe('describeCondition', () => {
  const ctx = {
    ref: (n: string) => n,
    label: (n: string, c: string | number) => (n === 'SEX' && c === 2 ? 'Female' : null),
    t: (k: string, v: Record<string, string>) =>
      ({
        'paper.is': `${v.q} is ${v.value}`,
        'paper.compare': `${v.q} ${v.op} ${v.value}`,
        'paper.and': `${v.a} and ${v.b}`,
        'paper.or': `${v.a} or ${v.b}`,
        'paper.notAnswered': `${v.q} is not answered`,
      })[k] ?? k,
  };
  it('brackets mixed and/or and compares variables', () => {
    expect(describeCondition(parse('AGE >= 18 and (SEX == 2 or KIDS > ADULTS)'), ctx)).toBe(
      'AGE ≥ 18 and (SEX is “Female” (2) or KIDS > ADULTS)',
    );
    expect(describeCondition(parse('not answered(Q1)'), ctx)).toBe('Q1 is not answered');
  });
});

describe('routingMap', () => {
  it('lists conditions, skips, ends and dependencies of the household survey', () => {
    const map = routingMap(Questionnaire.parse(household));
    const byId = new Map(map.map((n) => [n.id, n]));
    const withSkips = map.filter((n) => n.skips.length);
    expect(withSkips.length).toBeGreaterThan(0);
    for (const n of withSkips)
      for (const s of n.skips)
        if (typeof s.target === 'number') expect(s.target).toBeGreaterThan(n.index);
    expect(map.some((n) => n.ends.length)).toBe(true);
    expect(map.some((n) => n.showIf)).toBe(true);
    const roster = map.find((n) => n.kind === 'roster')!;
    expect(roster.roster).toBeDefined();
    // Rosters collect readers of their row variables too; check plain variables.
    for (const n of map.filter((x) => x.kind === 'question' && x.depth <= 1))
      for (const id of n.readBy) expect(byId.get(id)!.reads).toContain(n.name);
  });
});
