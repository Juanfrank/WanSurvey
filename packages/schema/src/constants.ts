/**
 * Plain values without the validation library, for code that runs in a respondent's browser
 * (the engine): importing them from here keeps zod out of that download (H6).
 */
/** Skip targets: the end of the questionnaire, and the end of the current roster row. */
export const SKIP_END = 'END';
export const SKIP_END_ROW = 'END_ROW';

/**
 * The version of the terms of use and confidentiality undertaking that staff accept at their
 * first access. Raise it whenever the text changes (apps/web/src/about/content.ts): everyone is
 * asked again, and each acceptance records the version it was for.
 */
export const TERMS_VERSION = 1;
