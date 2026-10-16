import { createContext, useCallback, useContext } from 'react';

/**
 * The questionnaire whose cases are shown: each questionnaire of a project has its own cases,
 * sample and assignment rules. Undefined: the project's first questionnaire (the API default).
 */
export const QuestionnaireScope = createContext<string | undefined>(undefined);

export const useQuestionnaireScope = () => useContext(QuestionnaireScope);

/** Adds the questionnaire in scope to an API path. */
export function useScoped() {
  const q = useQuestionnaireScope();
  return useCallback(
    (path: string) =>
      q ? `${path}${path.includes('?') ? '&' : '?'}questionnaireId=${encodeURIComponent(q)}` : path,
    [q],
  );
}
