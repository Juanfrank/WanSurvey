import { Questionnaire, type QuestionnaireInput } from '@wansurvey/schema';
import { analyze, type Diagnostic } from './analyzer.js';
import { stableStringify, sha256 } from './hash.js';
import type { Model } from './model.js';

export const COMPILED_FORMAT_VERSION = 1;

/**
 * The published, executable form of a questionnaire. Plain JSON: it is stored next to the
 * definition, shipped to offline devices, and loaded by the server to re-run logic on submit.
 */
export interface CompiledQuestionnaire extends Omit<Model, 'problems'> {
  formatVersion: typeof COMPILED_FORMAT_VERSION;
  /** SHA-256 of the canonical questionnaire definition. */
  hash: string;
}

export class CompileError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(
      `Questionnaire has ${diagnostics.filter((d) => d.severity === 'error').length} error(s): ` +
        diagnostics
          .filter((d) => d.severity === 'error')
          .slice(0, 5)
          .map((d) => `${d.itemId ? `[${d.itemId}] ` : ''}${d.message}`)
          .join('; '),
    );
    this.name = 'CompileError';
  }
}

export function questionnaireHash(q: Questionnaire): string {
  return sha256(stableStringify(q));
}

/** Validates (Zod), analyses and compiles. Throws CompileError when publishing would be blocked. */
export function compile(input: QuestionnaireInput | Questionnaire): CompiledQuestionnaire {
  const questionnaire = Questionnaire.parse(input);
  const { model, diagnostics, canPublish } = analyze(questionnaire);
  if (!canPublish) throw new CompileError(diagnostics);
  const { problems: _problems, ...rest } = model;
  return {
    formatVersion: COMPILED_FORMAT_VERSION,
    hash: questionnaireHash(questionnaire),
    ...rest,
  };
}
