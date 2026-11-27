import { render, screen } from '@testing-library/react';
import { household } from '@wansurvey/fixtures';
import { compile, createInterview, respondentFromCase } from '@wansurvey/logic';
import { describe, expect, it } from 'vitest';
import { sectionsOf } from '../src/interview/InterviewPage.js';
import { AnswersSoFar, fieldLabel, SampleData } from '../src/interview/side.js';
import i18n from 'i18next';

const sample = { region: 2, city: 'Arequipa', first_name: 'Juan', zone_code: 'Z1' };
const start = () =>
  createInterview(compile(household), {
    mode: 'CAPI',
    language: 'es',
    seed: 'test',
    now: () => new Date('2026-10-12T10:00:00Z'),
    context: { case: sample, respondent: respondentFromCase(sample) },
  });

describe('interviewer side panel', () => {
  it('marks the section current on its opening text', () => {
    const s = start();
    expect(s.currentKey()).toBe('A0_CONSENT_TEXT');
    expect(sectionsOf(s, 'es')[0]!.status).toBe('current');
  });

  it('names sample columns for people and labels coded ones from their question', () => {
    const t = i18n.t.bind(i18n);
    expect(fieldLabel(t, 'first_name')).toBe('First name');
    expect(fieldLabel(t, 'zone_code')).toBe('Zone code');
    render(<SampleData session={start()} data={sample} />);
    const dl = screen.getByTestId('sample-data');
    expect(dl.textContent).toContain('City');
    expect(dl.textContent).toContain('Sur (2)');
  });

  it('keeps prefilled answers not yet asked apart from the answers given', () => {
    const s = start();
    render(<AnswersSoFar session={s} />);
    expect(screen.queryByTestId('answers-so-far')).toBeNull();
    expect(screen.getByTestId('prefilled-answers').textContent).toContain('E5_REGION');
    expect(screen.getByText('Sample data to confirm')).toBeTruthy();
  });
});
