/**
 * Plain values without the validation library, for code that runs in a respondent's browser
 * (the engine): importing them from here keeps zod out of that download (H6).
 */
/** Skip targets: the end of the questionnaire, and the end of the current roster row. */
export const SKIP_END = 'END';
export const SKIP_END_ROW = 'END_ROW';
