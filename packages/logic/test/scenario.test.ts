import { describe, expect, it } from 'vitest';
import { Scenario } from '@wansurvey/schema';
import { household } from '@wansurvey/fixtures';
import { compile } from '../src/compile.js';
import { runScenario } from '../src/scenario.js';

const compiled = compile(household);
const ctx = { case: { city: 'Lima', region: 1 }, respondent: { firstName: 'Rosa' } };

describe('scenarios', () => {
  it('passes when the expectations hold', () => {
    const s = Scenario.parse({
      name: 'single, screened in',
      mode: 'CAPI',
      context: ctx,
      today: '2026-10-12',
      steps: [
        { answer: 'A1_CONSENT', value: 1 },
        { answer: 'A2_AGE', value: 40 },
        { answer: 'A3_SEX', value: 2 },
        { answer: 'A4_MARITAL', value: 1 },
        { answer: 'A4_SPOUSE', value: 'Pat' },
        { answer: 'A4_MARITAL', value: 2 },
      ],
      expect: {
        pathIncludes: ['A5_NAME'],
        pathExcludes: ['A4_SPOUSE'],
        outcome: 'incomplete',
        answers: { A4_SPOUSE: null, A2_AGE: 40 },
        cleared: ['A4_SPOUSE'],
        errors: [{ key: 'A5_NAME', ruleId: 'required' }],
      },
    });
    const r = runScenario(compiled, s);
    expect(r.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('reports each failed expectation, bad steps and end states', () => {
    const r = runScenario(
      compiled,
      Scenario.parse({
        name: 'screened out',
        mode: 'CATI',
        steps: [
          { answer: 'A1_CONSENT', value: 1 },
          { answer: 'A2_AGE', value: 15 },
          { answer: 'A3_SEX', value: 1 },
        ],
        expect: { outcome: 'complete', disposition: 'SCREENED_OUT', pathIncludes: ['A3_SEX'] },
      }),
    );
    expect(r.passed).toBe(false);
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.label);
    expect(failed).toEqual([
      'step 3: answer A3_SEX',
      'A3_SEX is on the path',
      'outcome is complete',
    ]);
    expect(r.checks.find((c) => c.label.startsWith('disposition'))!.passed).toBe(true);
  });

  it('round-trips through JSON (saved scenarios)', () => {
    const s = Scenario.parse({
      name: 'n',
      mode: 'CAWI',
      steps: [{ answer: 'A1_CONSENT', value: 2 }],
      expect: { outcome: 'ended', disposition: 'REFUSAL' },
    });
    expect(runScenario(compiled, Scenario.parse(JSON.parse(JSON.stringify(s)))).passed).toBe(true);
  });
});
