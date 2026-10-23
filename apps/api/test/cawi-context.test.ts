import { household } from '@wansurvey/fixtures';
import { compile } from '@wansurvey/logic';
import { describe, expect, it } from 'vitest';
import { caseFieldsFor } from '../src/cawi/cawi.service.js';

describe('web respondent context', () => {
  it('keeps only the case fields the questionnaire reads', () => {
    const compiled = compile(household as never);
    const sample = { city: 'Lima', first_name: 'Ana', phone: '999', dni: '123', region: 2 };
    // household pipes {{case.city}} and {{respondent.firstName}}, and prefills case.region.
    expect(caseFieldsFor(compiled, sample)).toEqual({ city: 'Lima', first_name: 'Ana', region: 2 });
  });
});
