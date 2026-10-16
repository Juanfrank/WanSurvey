import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { allTypes, household } from '@wansurvey/fixtures';
import { compile, createInterview, type InterviewSession } from '@wansurvey/logic';
import type { AnswerValue, Mode } from '@wansurvey/schema';
import { PaperForm } from '../src/PaperForm.js';
import { QuestionView } from '../src/QuestionView.js';
import { expectNoAxeViolations } from './axe.js';

const compiled = compile(allTypes);

/** Every path item of the all-types sample, rendered at once, wired to a real session. */
function AllQuestions({ session, mode }: { session: InterviewSession; mode: Mode }) {
  const [, setRev] = useState(0);
  const bump = () => setRev((r) => r + 1);
  return (
    <div>
      {session.path().map((entry) => (
        <QuestionView
          key={entry.key}
          session={session}
          entry={entry}
          mode={mode}
          lang="en"
          showAllErrors={false}
          onAnswer={(k: string, v: AnswerValue) => {
            session.setAnswer(k, v);
            bump();
          }}
          onSpecial={(k, kind) => {
            if (kind) session.setSpecial(k, kind);
            else session.clearAnswer(k);
            bump();
          }}
          onConfirm={(k, r, on = true) => {
            if (on) session.confirmWarning(k, r);
            else session.unconfirmWarning(k, r);
            bump();
          }}
        />
      ))}
    </div>
  );
}

function setup(mode: Mode) {
  const session = createInterview(compiled, { mode, now: () => new Date('2026-10-12T00:00:00Z') });
  const user = userEvent.setup();
  const utils = render(<AllQuestions session={session} mode={mode} />);
  const q = (key: string) => within(document.querySelector(`[data-qkey="${key}"]`) as HTMLElement);
  return { session, user, q, ...utils };
}

describe('answer controls', () => {
  it.each(['CATI', 'CAPI', 'CAWI'] as const)(
    'every question type renders without axe violations in %s',
    async (mode) => {
      const { container } = setup(mode);
      await expectNoAxeViolations(container);
    },
  );

  it('single choice: radios, dropdown, and buttons for respondents', async () => {
    const { user, q, session } = setup('CAWI');
    await user.click(q('Q_SINGLE').getByLabelText('Mango'));
    expect(session.getAnswer('Q_SINGLE')).toBe(3);
    // The dropdown searches as you type (accents ignored); Enter picks the highlighted option.
    await user.type(q('Q_DROPDOWN').getByRole('combobox'), 'chi');
    expect(
      q('Q_DROPDOWN')
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Chile']);
    await user.keyboard('{Enter}');
    expect(session.getAnswer('Q_DROPDOWN')).toBe(2);
    expect(q('Q_DROPDOWN').getByTestId('chosen-option').textContent).toMatch(/Chile/);
  });

  it('multi choice handles exclusive options and other-specify', async () => {
    const { user, q, session } = setup('CAPI');
    await user.click(q('Q_MULTI').getByLabelText(/Bus$/));
    await user.click(q('Q_MULTI').getByLabelText(/Otro$/));
    expect(session.getAnswer('Q_MULTI')).toEqual([1, 4]);
    await user.type(q('Q_MULTI').getByLabelText('Please specify'), 'Boat');
    expect(session.getAnswer('Q_MULTI_OTHER')).toBe('Boat');
    await user.click(q('Q_MULTI').getByLabelText(/Ninguno$/));
    expect(session.getAnswer('Q_MULTI')).toEqual([99]);
    expect(session.getAnswer('Q_MULTI_OTHER')).toBeNull(); // cleared with the "other" option
  });

  it('numeric, text, date and time inputs', async () => {
    const { user, q, session } = setup('CAPI');
    await user.type(q('Q_NUMBER').getByRole('textbox'), '7,5');
    expect(session.getAnswer('Q_NUMBER')).toBe(7.5);
    await user.clear(q('Q_NUMBER').getByRole('textbox'));
    await user.type(q('Q_NUMBER').getByRole('textbox'), 'abc');
    expect(q('Q_NUMBER').getByText('Enter a number')).toBeTruthy();
    await user.type(q('Q_CITY').getByRole('textbox'), 'Cusco');
    expect(session.getAnswer('Q_CITY')).toBe('Cusco');
    const date = document.querySelector('[data-qkey="Q_DATE"] input') as HTMLInputElement;
    await user.type(date, '1990-05-04');
    expect(session.getAnswer('Q_DATE')).toBe('1990-05-04');
  });

  it('soft checks show a confirmation', async () => {
    const { user, q, session } = setup('CAPI');
    await user.type(q('Q_NUMBER').getByRole('textbox'), '2');
    await user.click(q('Q_NUMBER').getByLabelText(/I have checked this answer/));
    expect(session.validate('Q_NUMBER').canProceed).toBe(true);
    // The confirmation can be taken back.
    await user.click(q('Q_NUMBER').getByLabelText(/I have checked this answer/));
    expect(session.validate('Q_NUMBER').canProceed).toBe(false);
  });

  it('scales, grid and ranking', async () => {
    const { user, q, session } = setup('CATI');
    await user.click(q('Q_NPS').getByLabelText('10 – Muy probable'));
    expect(session.getAnswer('Q_NPS')).toBe(10);
    await user.click(q('Q_GRID').getAllByLabelText(/Bueno$/)[0]!);
    await user.click(q('Q_GRID').getAllByLabelText(/Malo$/)[1]!);
    expect(session.getAnswer('Q_GRID')).toEqual({ water: 3, power: 1 });
    await user.click(q('Q_RANK').getByRole('button', { name: 'Move Empleo up' }));
    expect(session.getAnswer('Q_RANK')).toEqual([1, 3, 2]);
  });

  it('special codes are offered to interviewers only', () => {
    expect(
      setup('CATI')
        .q('Q_SINGLE')
        .getByRole('button', { name: /Refused/ }),
    ).toBeTruthy();
  });

  it('respondents see no special-code buttons', () => {
    expect(
      setup('CAWI')
        .q('Q_SINGLE')
        .queryByRole('button', { name: /Refused/ }),
    ).toBeNull();
  });

  it('shows the interviewer instruction only in interviewer modes', () => {
    expect(setup('CATI').q('Q_SINGLE').getByRole('note').textContent).toBe('LEA LAS OPCIONES');
  });
});

describe('PaperForm (PAPI)', () => {
  it('numbers questions, prints codes and routing instructions', async () => {
    const { container } = render(<PaperForm compiled={compile(household)} lang="en" />);
    const q = (n: string) =>
      within(container.querySelector(`[data-paper-q="${n}"]`) as HTMLElement);
    expect(q('Q1').getByText('¿Acepta participar?')).toBeTruthy();
    expect(q('Q1').getByText('If Q1 is “No” (2) → end the interview (REFUSAL)')).toBeTruthy();
    expect(q('Q4').getByText('If Q4 is not “Casado/a” (1) → go to Q6')).toBeTruthy();
    expect(q('Q5').getByText('¿Cómo se llama [su esposa / su esposo]?')).toBeTruthy();
    expect(q('Q2').getByText('-8')).toBeTruthy(); // DK code printed
    expect(screen.getByText('Repeat for each row (up to 10)')).toBeTruthy();
    expect(q('Q20').getByText('Ask only if Q19 is one of “Pozo” (2), “Río” (3)')).toBeTruthy();
    expect(q('Q11').getByText('If Q11 < 5 → go to the next person')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
