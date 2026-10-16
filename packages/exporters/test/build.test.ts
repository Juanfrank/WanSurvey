import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { buildTables, type ExportInterview } from '../src/index.js';

const es = (text: string) => ({ es: text });
const compiled = compile(
  Questionnaire.parse({
    id: 'HOGAR',
    title: es('Hogar'),
    defaultLanguage: 'es',
    languages: ['es'],
    sections: [
      {
        id: 'S',
        title: es('S'),
        items: [
          {
            kind: 'question',
            id: 'SEX',
            name: 'SEX',
            type: 'single',
            text: es('¿Sexo?'),
            options: [
              { code: 1, label: es('Hombre') },
              { code: 2, label: es('Mujer') },
              { code: 9, label: es('Otro'), otherSpecify: true },
            ],
          },
          {
            kind: 'question',
            id: 'MEDIA',
            name: 'MEDIA',
            type: 'multi',
            text: es('¿Qué medios usa?'),
            options: [
              { code: 1, label: es('Radio') },
              { code: 2, label: es('TV') },
            ],
          },
          {
            kind: 'question',
            id: 'SAT',
            name: 'SAT',
            type: 'grid',
            text: es('Satisfacción'),
            options: [
              { code: 1, label: es('Mala') },
              { code: 2, label: es('Buena') },
            ],
            rows: [
              { code: 'a', label: es('Agua') },
              { code: 'b', label: es('Luz') },
            ],
          },
          {
            kind: 'roster',
            id: 'HH',
            name: 'HH',
            title: es('Personas'),
            count: { type: 'open', max: 10 },
            items: [
              { kind: 'question', id: 'NAME', name: 'NAME', type: 'text', text: es('Nombre') },
              {
                kind: 'question',
                id: 'AGE',
                name: 'AGE',
                type: 'numeric',
                text: es('Edad de {{roster.NAME}}'),
              },
            ],
          },
        ],
      },
    ],
  }),
);

const base = {
  status: 'approved',
  disposition: 'COMPLETE',
  interviewer: 'Ana',
  startedAt: '2026-10-13T10:00:00Z',
  submittedAt: '2026-10-13T10:20:00Z',
  activeMs: 600_000,
  version: 1,
  language: 'es',
};
const interviews: ExportInterview[] = [
  {
    ...base,
    id: 'i1',
    caseId: 'HH0001',
    mode: 'CATI',
    answers: {
      SEX: 9,
      SEX_OTHER: 'No binario',
      MEDIA: [2],
      SAT: { a: 1, b: { $special: 'DK' } },
      HH: [
        { NAME: 'Rosa', AGE: 40 },
        { NAME: 'Luis', AGE: 12 },
      ],
      SEX_CODE: 3,
    },
  },
  {
    ...base,
    id: 'i2',
    caseId: 'HH0002',
    mode: 'CAWI',
    answers: { SEX: { $special: 'RF' }, MEDIA: [1, 2], HH: [{ NAME: 'Eva', AGE: 30 }] },
    paradata: { backMoves: 2, notes: 0, pauses: 1, warnings: 0 },
    flags: { speeding: 900 },
  },
];

describe('export dataset', () => {
  it('one column per variable in order, the same for every mode; rosters wide', () => {
    const { main, rosters } = buildTables(compiled, interviews, {
      rosters: 'wide',
      paradata: true,
    });
    expect(rosters).toEqual([]);
    const names = main.columns.map((c) => c.name);
    expect(names.slice(0, 4)).toEqual(['interview_id', 'case_id', 'case_code', 'mode']);
    expect(names.slice(12, 16)).toEqual([
      'selection_role',
      'stratum',
      'inclusion_prob',
      'base_weight',
    ]);
    expect(names.slice(16)).toEqual([
      'SEX',
      'SEX_OTHER',
      'MEDIA_1',
      'MEDIA_2',
      'SAT_a',
      'SAT_b',
      'SEX_CODE',
      'NAME_1',
      'AGE_1',
      'NAME_2',
      'AGE_2',
      'back_moves',
      'notes',
      'pauses',
      'warnings_confirmed',
      'flags',
    ]);
    const get = (row: number, name: string) => main.rows[row]![names.indexOf(name)];
    expect(get(0, 'mode')).toBe('CATI');
    expect(get(1, 'mode')).toBe('CAWI');
    expect(get(0, 'SEX')).toBe(9);
    expect(get(0, 'SEX_OTHER')).toBe('No binario');
    expect([get(0, 'MEDIA_1'), get(0, 'MEDIA_2')]).toEqual([0, 1]);
    expect([get(0, 'SAT_a'), get(0, 'SAT_b')]).toEqual([1, -8]);
    expect(get(1, 'SEX')).toBe(-9);
    expect([get(0, 'NAME_2'), get(0, 'AGE_2')]).toEqual(['Luis', 12]);
    expect([get(1, 'NAME_2'), get(1, 'AGE_2')]).toEqual([null, null]);
    expect(get(1, 'flags')).toBe('speeding');
    const sex = main.columns.find((c) => c.name === 'SEX')!;
    expect(sex.label).toBe('¿Sexo?');
    expect(sex.valueLabels?.get(2)).toBe('Mujer');
    expect(sex.valueLabels?.get(-8)).toBe('No sabe');
    expect(sex.missing).toEqual(expect.arrayContaining([-8, -9]));
    expect(main.columns.find((c) => c.name === 'AGE_2')!.label).toBe('Edad de … [2]');
  });

  it('rosters long: a table per roster with row numbers', () => {
    const { main, rosters } = buildTables(compiled, interviews, {
      rosters: 'long',
      paradata: false,
    });
    expect(main.columns.some((c) => c.name.startsWith('NAME'))).toBe(false);
    expect(rosters).toHaveLength(1);
    expect(rosters[0]!.columns.map((c) => c.name)).toEqual([
      'interview_id',
      'case_id',
      'HH_row',
      'NAME',
      'AGE',
    ]);
    expect(rosters[0]!.rows).toEqual([
      ['i1', 'HH0001', 1, 'Rosa', 40],
      ['i1', 'HH0001', 2, 'Luis', 12],
      ['i2', 'HH0002', 1, 'Eva', 30],
    ]);
  });
});

describe('personal answers', () => {
  const withPhone = compile(
    Questionnaire.parse({
      id: 'P',
      title: es('P'),
      defaultLanguage: 'es',
      languages: ['es'],
      sections: [
        {
          id: 'S',
          title: es('S'),
          items: [
            { kind: 'question', id: 'AGE', name: 'AGE', type: 'numeric', text: es('¿Edad?') },
            {
              kind: 'question',
              id: 'PHONE',
              name: 'PHONE',
              type: 'text',
              personal: true,
              text: es('¿Teléfono?'),
            },
          ],
        },
      ],
    }),
  );
  const one: ExportInterview = {
    id: 'i1',
    caseId: null,
    mode: 'CAWI',
    status: 'submitted',
    disposition: 'COMPLETE',
    interviewer: null,
    startedAt: '2026-01-01T00:00:00Z',
    submittedAt: '2026-01-01T00:10:00Z',
    activeMs: 600_000,
    version: 1,
    language: 'es',
    answers: { AGE: 30, PHONE: '987654321' },
  };
  const names = (personal?: boolean) =>
    buildTables(withPhone, [one], {
      rosters: 'wide',
      paradata: false,
      ...(personal === undefined ? {} : { personal }),
    }).main.columns.map((c) => c.name);

  it('are left out for people without access to personal data', () => {
    expect(names()).toContain('PHONE');
    expect(names(false)).not.toContain('PHONE');
    expect(names(false)).toContain('AGE');
  });
});
