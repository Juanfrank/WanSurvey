import { describe, expect, it } from 'vitest';
import { codebook, crosstab, filterRows, topline, type Table } from '../src/index.js';

const labels = (pairs: [number, string][]) => new Map(pairs);
const table: Table = {
  name: 't',
  columns: [
    { name: 'interview_id', label: 'id', type: 'string' },
    {
      name: 'SEX',
      label: 'Sexo',
      type: 'numeric',
      valueLabels: labels([
        [1, 'Hombre'],
        [2, 'Mujer'],
        [-8, 'No sabe'],
      ]),
      missing: [-8],
      measure: 'nominal',
      variable: true,
    },
    {
      name: 'AGE',
      label: 'Edad',
      type: 'numeric',
      valueLabels: labels([[-8, 'No sabe']]),
      missing: [-8],
      measure: 'scale',
      variable: true,
    },
    ...['A', 'B'].map((o) => ({
      name: `M_${o}`,
      label: `Medios: ${o}`,
      type: 'numeric' as const,
      valueLabels: labels([
        [0, 'No'],
        [1, 'Sí'],
        [-8, 'No sabe'],
      ]),
      missing: [-8],
      measure: 'nominal' as const,
      group: { name: 'M', label: 'Medios' },
      variable: true,
    })),
    {
      name: 'ZONE',
      label: 'Zona',
      type: 'numeric',
      valueLabels: labels([
        [1, 'Urbana'],
        [2, 'Rural'],
      ]),
      measure: 'nominal',
      variable: true,
    },
  ],
  rows: [
    ['a', 1, 30, 1, 0, 1],
    ['b', 2, 40, 1, 1, 1],
    ['c', 2, -8, 0, 1, 2],
    ['d', -8, 50, -8, -8, 2],
    ['e', null, null, null, null, null],
  ],
};

describe('topline', () => {
  const items = topline(table);

  it('counts coded answers over valid answers, specials apart', () => {
    const sex = items.find((i) => i.name === 'SEX')!;
    expect(sex).toMatchObject({ kind: 'single', base: 3 });
    if (sex.kind !== 'single') throw new Error();
    expect(sex.rows.map((r) => [r.code, r.count, r.percent && Math.round(r.percent)])).toEqual([
      [1, 1, 33],
      [2, 2, 67],
      [-8, 1, null],
    ]);
  });

  it('summarises numbers without missing codes', () => {
    expect(items.find((i) => i.name === 'AGE')).toMatchObject({
      kind: 'numeric',
      n: 3,
      mean: 40,
      median: 40,
      min: 30,
      max: 50,
    });
  });

  it('groups the options of a multiple choice', () => {
    const m = items.find((i) => i.name === 'M')!;
    expect(m).toMatchObject({ kind: 'multi', label: 'Medios', base: 3 });
    if (m.kind !== 'multi') throw new Error();
    expect(m.rows.map((r) => [r.code, r.label, r.count])).toEqual([
      ['A', 'A', 2],
      ['B', 'B', 2],
    ]);
  });
});

describe('crosstab', () => {
  it('counts valid pairs with column percentages', () => {
    const x = crosstab(table, 'SEX', 'ZONE')!;
    expect(x.counts).toEqual([
      [1, 0],
      [1, 1],
    ]);
    expect(x.colTotals).toEqual([2, 1]);
    expect(x.total).toBe(3);
    expect(x.colPercents[0]).toEqual([50, 0]);
  });

  it('refuses uncoded variables', () => {
    expect(crosstab(table, 'AGE', 'ZONE')).toBeNull();
  });

  it('filters rows by a closed question', () => {
    expect(filterRows(table, 'ZONE', [2]).rows.map((r) => r[0])).toEqual(['c', 'd']);
  });
});

describe('codebook', () => {
  it('lists values and marks missing codes', () => {
    const sex = codebook(table).find((e) => e.name === 'SEX')!;
    expect(sex.values).toContainEqual({ code: -8, label: 'No sabe', missing: true });
    expect(sex.measure).toBe('nominal');
  });
});
