export const QUESTIONNAIRE_STATES = ['active', 'disabled', 'completed'] as const;
export type QuestionnaireState = (typeof QUESTIONNAIRE_STATES)[number];

/** Why a questionnaire takes no new fills, or null when it does. */
export function closedCode(state: string | null | undefined) {
  return state === 'disabled'
    ? 'QUESTIONNAIRE_DISABLED'
    : state === 'completed'
      ? 'QUESTIONNAIRE_COMPLETED'
      : null;
}
