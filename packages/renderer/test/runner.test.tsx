import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { household } from '@wansurvey/fixtures';
import { compile, createInterview } from '@wansurvey/logic';
import type { Mode } from '@wansurvey/schema';
import { InterviewRunner } from '../src/InterviewRunner.js';
import { expectNoAxeViolations } from './axe.js';

const compiled = compile(household);
const context = {
  case: { city: 'Lima', region: 1 },
  respondent: { firstName: 'Rosa' },
  interviewer: { firstName: 'Juan' },
};

function setup(
  mode: Mode,
  opts: { narrow?: boolean; lang?: string; specialKeys?: { DK: string; RF: string } } = {},
) {
  const session = createInterview(compiled, {
    mode,
    context,
    now: () => new Date('2026-10-12T10:00:00Z'),
    seed: 't',
  });
  const user = userEvent.setup();
  const utils = render(
    <InterviewRunner
      session={session}
      mode={mode}
      lang={opts.lang ?? 'en'}
      narrow={opts.narrow ?? false}
      {...(opts.specialKeys ? { specialKeys: opts.specialKeys } : {})}
    />,
  );
  return { session, user, ...utils };
}

const question = () => document.querySelector('[data-qkey]')!.getAttribute('data-qkey');

describe('InterviewRunner (interviewer modes)', () => {
  it('shows interviewers where each answer of a branching question leads', async () => {
    const { user } = setup('CATI');
    await user.keyboard('{Enter}');
    expect(question()).toBe('A1_CONSENT');
    const routes = [...document.querySelectorAll('[data-route]')].map((e) => e.textContent);
    expect(routes).toEqual(['→ next question', '→ ends: refusal']);
  });

  it('shows no routes to respondents', async () => {
    const { user } = setup('CAWI', { narrow: true });
    await user.keyboard('{Enter}');
    expect(document.querySelectorAll('[data-route]').length).toBe(0);
  });

  it('runs by keyboard only: digits pick codes, Enter advances, Shift+Enter goes back', async () => {
    const { user, session } = setup('CATI');
    expect(question()).toBe('A0_CONSENT_TEXT');
    await user.keyboard('{Enter}');
    expect(question()).toBe('A1_CONSENT');
    await user.keyboard('1{Enter}');
    expect(session.getAnswer('A1_CONSENT')).toBe(1);
    expect(screen.getByText('¿Podría decirme su edad, por favor?')).toBeTruthy(); // CATI wording
    expect(document.activeElement?.tagName).toBe('INPUT'); // focus moved to the new control
    await user.keyboard('40{Enter}');
    expect(session.getAnswer('A2_AGE')).toBe(40);
    await user.keyboard('2{Enter}');
    expect(question()).toBe('A4_MARITAL');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(question()).toBe('A3_SEX');
  });

  it('Shift+Enter goes back also when focus is outside the questions', async () => {
    const { user } = setup('CATI');
    await user.keyboard('{Enter}1{Enter}');
    expect(question()).toBe('A2_AGE');
    // E.g. after a click on the case panel: focus is on the page, outside the runner.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(question()).toBe('A1_CONSENT');
  });

  it('blocks Next on errors and announces them; shows codes and the interviewer instruction', async () => {
    const { user } = setup('CAPI');
    await user.keyboard('{Enter}1{Enter}{Enter}');
    expect(screen.getByRole('alert').textContent).toMatch(/fix the highlighted answers/);
    expect(screen.getByText('An answer is required')).toBeTruthy();
    await user.keyboard('130');
    expect(screen.getByText('The maximum is 120')).toBeTruthy();
    await user.clear(screen.getByRole('textbox'));
    await user.keyboard('40{Enter}');
    expect(screen.getByRole('note', { name: 'Interviewer instruction' }).textContent).toBe(
      'REGISTRE SIN PREGUNTAR SI ES OBVIO',
    );
    expect(screen.getAllByText('1').length).toBeGreaterThan(0); // option codes visible
  });

  it('F7/F8 record Don’t know / Refused', async () => {
    const { user, session } = setup('CATI');
    await user.keyboard('{Enter}1{Enter}');
    await user.keyboard('{F7}');
    expect(session.getAnswer('A2_AGE')).toEqual({ $special: 'DK' });
    expect(screen.getByRole('button', { name: /Don't know/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.keyboard('{F8}');
    expect(session.getAnswer('A2_AGE')).toEqual({ $special: 'RF' });
  });

  it("uses the project's keys for don't know and refused, and shows them", async () => {
    const { user, session } = setup('CATI', { specialKeys: { DK: 'F2', RF: 'F4' } });
    await user.keyboard('{Enter}1{Enter}');
    await user.keyboard('{F7}');
    expect(session.getAnswer('A2_AGE')).toBeNull();
    await user.keyboard('{F2}');
    expect(session.getAnswer('A2_AGE')).toEqual({ $special: 'DK' });
    expect(screen.getByRole('button', { name: /Don't know/ }).textContent).toContain('F2');
    await user.keyboard('{F4}');
    expect(session.getAnswer('A2_AGE')).toEqual({ $special: 'RF' });
  });

  it('announces answers cleared by a path change', async () => {
    const { user, session } = setup('CATI');
    await user.keyboard('{Enter}1{Enter}40{Enter}2{Enter}1{Enter}');
    await user.keyboard('Pat{Control>}{Enter}{/Control}');
    expect(session.getAnswer('A4_SPOUSE')).toBe('Pat');
    await user.keyboard('{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}');
    expect(question()).toBe('A4_MARITAL');
    await user.keyboard('2');
    expect(screen.getByRole('status').textContent).toMatch(/removed 1 later answer.*A4_SPOUSE/);
    expect(session.getAnswer('A4_SPOUSE')).toBeNull();
  });

  it('translates the interface and built-in messages into Spanish', async () => {
    await act(() => i18next.changeLanguage('es'));
    const { user } = setup('CAPI', { lang: 'es' });
    expect(screen.getByRole('button', { name: /Siguiente/ })).toBeTruthy();
    await user.keyboard('{Enter}1{Enter}130');
    expect(screen.getByText('El máximo es 120')).toBeTruthy();
    expect(screen.getByText('¿Cuál es su edad?')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container, user } = setup('CAPI');
    await user.keyboard('{Enter}1{Enter}{Enter}'); // show an error state too
    await expectNoAxeViolations(container);
  });
});

describe('InterviewRunner (respondent mode)', () => {
  it('groups a section on one page on wide screens', async () => {
    const { user, session } = setup('CAWI');
    const keys = [...document.querySelectorAll('[data-qkey]')].map((e) =>
      e.getAttribute('data-qkey'),
    );
    expect(keys).toEqual([
      'A0_CONSENT_TEXT',
      'A1_CONSENT',
      'A2_AGE',
      'A3_SEX',
      'A4_MARITAL',
      'A4_SPOUSE',
      'A5_NAME',
    ]);
    // No codes or DK/RF for respondents.
    expect(screen.queryByRole('button', { name: /Don't know/ })).toBeNull();
    const age = document.querySelector('[data-qkey="A2_AGE"]') as HTMLElement;
    expect(within(age).getByText('¿Cuántos años tiene?')).toBeTruthy();
    await user.click(
      within(document.querySelector('[data-qkey="A1_CONSENT"]') as HTMLElement).getByLabelText(
        'Yes',
      ),
    );
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(session.currentKey()).toBe('A2_AGE'); // stopped at the first unanswered required question
    expect(screen.getByRole('alert').textContent).not.toBe('');
  });

  it("uses the questionnaire's language for its buttons, while interviewers keep theirs", () => {
    // The interface is in English here; the questionnaire is shown in Spanish.
    setup('CAWI', { lang: 'es' });
    expect(screen.getByRole('button', { name: /Siguiente/ })).toBeTruthy();
    cleanup();
    setup('CATI', { lang: 'es' });
    expect(screen.getByRole('button', { name: /Next/ })).toBeTruthy();
  });

  it('shows one question per page on phones', () => {
    setup('CAWI', { narrow: true });
    expect(document.querySelectorAll('[data-qkey]')).toHaveLength(1);
  });

  it('has no axe violations', async () => {
    const { container } = setup('CAWI');
    await expectNoAxeViolations(container);
  });
});

describe('prefilled answers', () => {
  it('offers to restore the prefilled value after it was changed (L11)', async () => {
    const small = compile({
      id: 'P',
      title: { en: 'P' },
      defaultLanguage: 'en',
      languages: ['en'],
      sections: [
        {
          id: 'S',
          title: { en: 'S' },
          items: [
            {
              kind: 'question',
              id: 'REGION',
              name: 'REGION',
              type: 'numeric',
              text: { en: 'Region' },
              prefill: 'case.region',
            },
          ],
        },
      ],
    });
    const session = createInterview(small, { mode: 'CAPI', context, seed: 't' });
    const user = userEvent.setup();
    render(<InterviewRunner session={session} mode="CAPI" lang="en" narrow={false} />);
    expect(session.getAnswer('REGION')).toBe(1);
    expect(screen.queryByRole('button', { name: 'Restore the prefilled value' })).toBeNull();
    const input = screen.getByRole('textbox', { name: /Region/ });
    await user.clear(input);
    await user.type(input, '4');
    await user.click(screen.getByRole('button', { name: 'Restore the prefilled value' }));
    expect(session.getAnswer('REGION')).toBe(1);
    expect(screen.queryByRole('button', { name: 'Restore the prefilled value' })).toBeNull();
  });
});
