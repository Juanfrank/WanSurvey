import type { QuestionnaireInput } from '@wansurvey/schema';
import { allTypes } from './all-types.js';
import { household } from './household.js';

export { allTypes, household };

/** Samples offered in the designer preview. */
export const SAMPLES: { id: string; title: string; questionnaire: QuestionnaireInput }[] = [
  {
    id: 'household',
    title: 'Household survey (roster, skips, checks, piping)',
    questionnaire: household,
  },
  { id: 'all-types', title: 'Every question type', questionnaire: allTypes },
];
export { sampleRows, sampleTable, toCsv, SAMPLE_HEADERS, type SampleRow } from './sample.js';
