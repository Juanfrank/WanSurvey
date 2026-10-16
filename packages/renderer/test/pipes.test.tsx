import { allTypes, household } from '@wansurvey/fixtures';
import { compile, createInterview } from '@wansurvey/logic';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InterviewRunner } from '../src/InterviewRunner.js';
import { PaperForm, paperText } from '../src/PaperForm.js';

/** A pipe or a reference left as written: `{{X}}`, `[case.city]`, `«X»`. */
const RAW = /\{\{[^}]*\}\}|«[^»]*»|\[[a-zA-Z_][\w.]*\]/g;

describe('dynamic fields', () => {
  it('no format shows a pipe as written, even with nothing known yet', () => {
    for (const q of [household, allTypes]) {
      const compiled = compile(q as never);
      const paper = renderToStaticMarkup(<PaperForm compiled={compiled} lang="es" />);
      expect(paper.match(RAW), `PAPI ${q.id}`).toBeNull();
      for (const mode of ['CATI', 'CAPI', 'CAWI'] as const) {
        const s = createInterview(compiled, { mode, seed: 'x', now: () => new Date() });
        const html = renderToStaticMarkup(
          <InterviewRunner session={s} mode={mode} lang="es" narrow={false} />,
        );
        expect(html.match(RAW), `${mode} ${q.id}`).toBeNull();
      }
    }
  });

  it('paper fills the case data it is printed with, and a line for answers', () => {
    const ctx = { case: { city: 'Lima' }, respondent: { firstName: 'Rosa' } };
    expect(paperText('Hola {{respondent.firstName}}, en {{case.city}}', ctx)).toBe(
      'Hola Rosa, en Lima',
    );
    expect(paperText('¿Qué edad tiene {{M_NAME}}?')).toBe('¿Qué edad tiene ________?');
    expect(paperText('Vive en {{case.region | default:"su región"}}', ctx)).toBe(
      'Vive en su región',
    );
  });
});

describe('paper for scanners', () => {
  it('special answers are circles like the options; each question and form is marked', () => {
    const compiled = compile(allTypes as never);
    const html = renderToStaticMarkup(<PaperForm compiled={compiled} lang="es" formId="HH0001" />);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const q = doc.querySelector('[data-paper-q]')!;
    expect(q.querySelector('.paper-anchor')).not.toBeNull();
    expect(q.querySelector('.paper-var')?.textContent).toBe('Q_SINGLE');
    expect(q.querySelector('[data-special="DK"] .paper-bubble')).not.toBeNull();
    const bands = doc.querySelectorAll('[data-band]');
    expect([...bands].map((b) => b.getAttribute('data-band'))).toEqual(['start', 'end']);
    expect(bands[0]!.textContent).toContain('HH0001');
  });
});
