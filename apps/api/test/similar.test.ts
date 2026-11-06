import { describe, expect, it } from 'vitest';
import {
  questionsOf,
  rankSimilar,
  similarity,
  words,
  type QuestionSource,
} from '../src/questionnaires/similar.js';

describe('similar questions', () => {
  it('keeps the meaningful words, without accents, markup, piped values or filler', () => {
    expect(words('<b>¿Cuál es su EDAD?</b> {{nombre}}')).toEqual(['edad']);
    expect(words('What is your household income?')).toEqual(['household', 'income']);
  });

  it('scores alike wordings high and unrelated ones low', () => {
    expect(similarity('¿Cuál es su edad?', 'Edad de la persona')).toBeGreaterThan(0.4);
    expect(similarity('¿Cuál es su edad?', '¿Cual es tu EDAD?')).toBe(1);
    expect(
      similarity('¿Cuántas personas viven en el hogar?', '¿Cuántas personas viven aquí?'),
    ).toBeGreaterThan(0.5);
    expect(similarity('¿Cuál es su edad?', '¿Trabajó la semana pasada?')).toBe(0);
    expect(similarity('', 'algo')).toBe(0);
  });

  it('reads the questions of a definition at any depth, in the language asked', () => {
    const def = {
      sections: [
        {
          items: [
            { kind: 'question', name: 'AGE', text: { es: '¿Edad?', en: 'Age?' } },
            {
              kind: 'roster',
              items: [{ kind: 'question', name: 'NOM', text: { es: 'Nombre' } }],
            },
            { kind: 'static', text: { es: 'No es una pregunta' } },
          ],
        },
      ],
    };
    expect(questionsOf(def, 'en')).toEqual([
      { variable: 'AGE', text: 'Age?' },
      { variable: 'NOM', text: 'Nombre' },
    ]);
  });

  it('ranks the best matches above the threshold', () => {
    const src = (text: string, id: string): QuestionSource => ({
      origin: { kind: 'questionnaire', id, name: id, projectId: 'p' },
      variable: 'V',
      text,
    });
    const found = rankSimilar(
      '¿Cuántos años tiene?',
      [
        src('Años cumplidos de la persona', 'a'),
        src('¿Cuántos años tiene usted?', 'b'),
        src('Color', 'c'),
      ],
      { min: 0.25 },
    );
    expect(found.map((f) => f.origin.id)).toEqual(['b', 'a']);
  });
});
