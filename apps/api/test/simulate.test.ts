import { household } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { Questionnaire } from '@wansurvey/schema';
import { describe, expect, it } from 'vitest';
import { simulateInterview } from '../src/db/simulate.js';

describe('simulated interviews', () => {
  it('reach the end of the household questionnaire in every mode', () => {
    const compiled = compile(Questionnaire.parse(household));
    for (const [i, mode] of ['CATI', 'CAPI', 'CAWI', 'PAPI'].entries()) {
      const s = simulateInterview(compiled, {
        mode,
        seed: `sim-${i}`,
        caseData: { first_name: 'Ana', city: 'Lima', region: 1 },
      });
      expect(
        s.status(),
        JSON.stringify({ mode, at: s.currentKey(), end: s.endState() }),
      ).toMatchObject({
        state: 'completed',
        disposition: 'COMPLETE',
      });
      expect(s.getAnswer('A1_CONSENT')).toBe(1);
      expect(Object.keys(s.getAnswers()).length).toBeGreaterThan(8);
    }
  });
});
