import { z } from 'zod';

export const MODES = ['CATI', 'CAPI', 'CAWI', 'PAPI'] as const;
export const Mode = z.enum(MODES);
export type Mode = z.infer<typeof Mode>;

/** BCP-47-ish language code, e.g. "en", "es", "pt-BR". */
export const LanguageCode = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Invalid language code');
export type LanguageCode = z.infer<typeof LanguageCode>;

/** Every user-facing string is a map of language → text. */
export const LocalizedText = z.record(z.string(), z.string());
export type LocalizedText = z.infer<typeof LocalizedText>;

export const Uuid = z.string().uuid();

/** Variable names are stable across modes and versions and end up as export column names. */
export const VariableName = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
    'Variable names start with a letter and use letters, digits and _',
  );

/** Item ids are used as skip targets; same shape as variable names. */
export const ItemId = VariableName;

/** Longest expression accepted; keeps parsing and evaluation well within the stack. */
export const MAX_EXPRESSION_LENGTH = 4000;

/** An expression in the WanSurvey logic language (see docs/logic-language.md). */
export const Expression = z.string().min(1).max(MAX_EXPRESSION_LENGTH);
export type Expression = z.infer<typeof Expression>;

export const IsoDateTime = z.string().datetime({ offset: true });
