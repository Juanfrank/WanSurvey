import { household } from '@wansurvey/fixtures';
import { describe, expect, it } from 'vitest';
import { caseFieldsUsed, compile } from '../src/index.js';

const es = (text: string) => ({ es: text });
const q = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'Q',
  title: es('Q'),
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [{ id: 'S', title: es('S'), items }],
  ...extra,
});
const text = (id: string, t: string) => ({ kind: 'static', id, text: es(t) });

describe('caseFieldsUsed', () => {
  it('finds the case fields of the household questionnaire: piped, prefilled and behind respondent', () => {
    const used = caseFieldsUsed(compile(household as never));
    expect(used.all).toBe(false);
    // {{respondent.firstName}} needs the first name; {{case.city}} and the prefill of the region.
    expect(used.fields).toEqual(['city', 'first_name', 'nombre', 'region']);
    expect(used.fields).not.toContain('last_name');
    expect(used.fields).not.toContain('phone');
  });

  it('reads pipes, conditions in texts, expressions and scripts', () => {
    const def = q(
      [
        text('T1', '¿Hablo con {{case.first_name | default:"usted"}}?'),
        text('T2', '{{#if case.address != ""}}Vive en {{case.address}}{{else}}—{{/if}}'),
        {
          kind: 'question',
          id: 'A',
          name: 'A',
          type: 'numeric',
          text: es('Edad'),
          showIf: 'case.age_band > 2 and A_OTHER == 1',
        },
      ],
      {
        scripts: [
          {
            id: 'INTRO',
            anchor: { at: 'start' },
            modes: ['CATI'],
            body: es('Buenas, ¿está {{respondent.lastName}}?'),
          },
        ],
      },
    );
    expect(caseFieldsUsed(def)).toEqual({
      fields: ['address', 'age_band', 'apellido', 'first_name', 'last_name'],
      all: false,
    });
  });

  it('ignores prose that only mentions the words, and counts a whole-case read as all', () => {
    expect(caseFieldsUsed(q([text('T', 'In case of doubt, ask the respondent again.')]))).toEqual({
      fields: [],
      all: false,
    });
    // A bare word (a label, a name) is not a read of the whole case.
    expect(caseFieldsUsed(q([text('T', 'respondent'), text('U', 'case')]))).toEqual({
      fields: [],
      all: false,
    });
    expect(caseFieldsUsed(q([text('T', 'Datos: {{case}}')])).all).toBe(true);
  });

  it('walks compiled syntax trees without counting their namespace as a whole read', () => {
    const compiled = compile(
      q([
        {
          kind: 'question',
          id: 'R',
          name: 'R',
          type: 'numeric',
          text: es('R'),
          prefill: 'case.region',
        },
      ]) as never,
    );
    expect(caseFieldsUsed(compiled)).toEqual({ fields: ['region'], all: false });
  });
});
