import type { VariableInfo } from '@wansurvey/logic';
import { createContext, useContext } from 'react';

/**
 * Variable types of the questionnaire being edited (from `buildModel`), so condition editors
 * can type-check what is typed. Null when the draft does not parse.
 */
export const TypeEnvContext = createContext<Record<string, VariableInfo> | null>(null);

export const useTypeVars = () => useContext(TypeEnvContext);
