import { Questionnaire } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { createInterview } from '../src/engine.js';

const es = (text: string) => ({ es: text });
const compiled = compile(
  Questionnaire.parse({
    id: 'SCRIPTS',
    title: es('Guiones'),
    defaultLanguage: 'es',
    languages: ['es'],
    sections: [
      {
        id: 'S1',
        title: es('Uno'),
        items: [{ kind: 'question', id: 'Q1', name: 'Q1', type: 'numeric', text: es('¿Edad?') }],
      },
    ],
    scripts: [
      {
        id: 'HI',
        anchor: { at: 'start' },
        modes: ['CATI'],
        body: es('Hola {{respondent.firstName}}'),
      },
      {
        id: 'SEC',
        anchor: { at: 'section', sectionId: 'S1' },
        modes: ['CATI', 'CAPI'],
        body: es('Sección'),
      },
      {
        id: 'ITEM',
        anchor: { at: 'item', itemId: 'Q1' },
        modes: ['CATI'],
        body: es('Lea despacio'),
      },
      { id: 'BYE', anchor: { at: 'end' }, modes: ['CATI'], body: es('Gracias') },
      {
        id: 'NO',
        anchor: { at: 'callOutcome', outcome: 'refusal' },
        modes: ['CATI'],
        body: es('Disculpe'),
      },
    ],
  }),
);

describe('interviewer scripts', () => {
  const session = (mode: 'CATI' | 'CAPI' | 'CAWI') =>
    createInterview(compiled, {
      mode,
      language: 'es',
      seed: 's',
      now: () => new Date('2026-10-12T12:00:00Z'),
      context: { respondent: { firstName: 'Rosa' } },
    });

  it('returns the scripts of the mode at each anchor, piped', () => {
    const s = session('CATI');
    expect(s.scriptsFor({ at: 'start' })).toEqual([{ id: 'HI', text: 'Hola Rosa' }]);
    expect(s.scriptsFor({ at: 'section', sectionId: 'S1' }).map((x) => x.id)).toEqual(['SEC']);
    expect(s.scriptsFor({ at: 'item', key: s.currentKey()! }).map((x) => x.id)).toEqual(['ITEM']);
    expect(s.scriptsFor({ at: 'end' }).map((x) => x.id)).toEqual(['BYE']);
    expect(s.scriptsFor({ at: 'callOutcome', outcome: 'refusal' }).map((x) => x.id)).toEqual([
      'NO',
    ]);
    expect(s.scriptsFor({ at: 'callOutcome', outcome: 'busy' })).toEqual([]);
  });

  it('gives other modes only their own scripts, and respondents none', () => {
    expect(session('CAPI').scriptsFor({ at: 'start' })).toEqual([]);
    expect(
      session('CAPI')
        .scriptsFor({ at: 'section', sectionId: 'S1' })
        .map((x) => x.id),
    ).toEqual(['SEC']);
    expect(session('CAWI').scriptsFor({ at: 'section', sectionId: 'S1' })).toEqual([]);
  });
});
