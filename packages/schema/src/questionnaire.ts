import { z } from 'zod';
import { Disposition } from './disposition.js';
import {
  Expression,
  ItemId,
  LanguageCode,
  LocalizedText,
  Mode,
  MODES,
  VariableName,
} from './common.js';

// ---------------------------------------------------------------------------
// Answer sets and special codes
// ---------------------------------------------------------------------------

export const Code = z.union([z.number().int(), z.string().min(1).max(32)]);
export type Code = z.infer<typeof Code>;

export const AnswerOption = z.strictObject({
  code: Code,
  label: LocalizedText,
  /** Selecting it deselects every other option (e.g. "None of these"). */
  exclusive: z.boolean().optional(),
  /** "Other, specify": asks for a text answer stored in `<VAR>_OTHER`. */
  otherSpecify: z.boolean().optional(),
  /** Keeps its position when options are randomised. */
  fixedPosition: z.boolean().optional(),
});
export type AnswerOption = z.infer<typeof AnswerOption>;

export const SPECIAL_KINDS = ['DK', 'RF', 'NA'] as const;
export const SpecialKind = z.enum(SPECIAL_KINDS);
export type SpecialKind = z.infer<typeof SpecialKind>;

export const SpecialCodeConfig = z.strictObject({
  code: Code,
  label: LocalizedText,
  /** Modes in which the code is offered. NA is never offered; it is assigned by routing. */
  offeredIn: z.array(Mode).default(['CATI', 'CAPI', 'PAPI']),
});
export type SpecialCodeConfig = z.infer<typeof SpecialCodeConfig>;

export const SpecialCodes = z.strictObject({
  DK: SpecialCodeConfig,
  RF: SpecialCodeConfig,
  NA: SpecialCodeConfig,
});
export type SpecialCodes = z.infer<typeof SpecialCodes>;

export const DEFAULT_SPECIAL_CODES: SpecialCodes = {
  DK: { code: -8, label: { es: 'No sabe' }, offeredIn: ['CATI', 'CAPI', 'PAPI'] },
  RF: { code: -9, label: { es: 'No responde' }, offeredIn: ['CATI', 'CAPI', 'PAPI'] },
  NA: { code: -7, label: { es: 'No aplica' }, offeredIn: [] },
};

// ---------------------------------------------------------------------------
// Mode variants (presentation only)
// ---------------------------------------------------------------------------

export const DisplayAs = z.enum([
  'radio',
  'dropdown',
  'buttons',
  'grid',
  'rowPerPage',
  'slider',
  'checkbox',
]);

/**
 * A mode variant overrides presentation only. It is a strict object so a variant can never
 * change the variable name, type or codes; data from every mode merges into one dataset.
 */
export const ModeVariant = z.strictObject({
  text: LocalizedText.optional(),
  interviewerInstruction: LocalizedText.optional(),
  readOptions: z.boolean().optional(),
  displayAs: DisplayAs.optional(),
  helpText: LocalizedText.optional(),
  showcard: z.string().optional(),
  printLayout: z
    .strictObject({
      columns: z.number().int().min(1).max(4).optional(),
      boxes: z.number().int().optional(),
    })
    .optional(),
  visibleInMode: z.boolean().optional(),
});
export type ModeVariant = z.infer<typeof ModeVariant>;

export const Variants = z.partialRecord(Mode, ModeVariant);
export type Variants = z.infer<typeof Variants>;

// ---------------------------------------------------------------------------
// Logic rules attached to items
// ---------------------------------------------------------------------------

export const SKIP_END = 'END';
export const SKIP_END_ROW = 'END_ROW';

export const SkipRule = z.strictObject({
  when: Expression,
  /** Item, block, roster or section id; `END` ends the questionnaire, `END_ROW` the current roster row. */
  to: z.string().min(1),
});
export type SkipRule = z.infer<typeof SkipRule>;

export const ValidationRule = z.strictObject({
  id: z.string().min(1),
  /** error = hard check (cannot proceed); warning = soft check (confirm and continue). */
  severity: z.enum(['error', 'warning']),
  /** The rule fires when this expression is true. */
  when: Expression,
  message: LocalizedText,
});
export type ValidationRule = z.infer<typeof ValidationRule>;

export const EndRule = z.strictObject({
  when: Expression,
  disposition: Disposition,
});
export type EndRule = z.infer<typeof EndRule>;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const QUESTION_TYPES = [
  'single',
  'multi',
  'numeric',
  'text',
  'date',
  'time',
  'datetime',
  'grid',
  'ranking',
  'scale',
  'yesno',
] as const;
export const QuestionType = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionType>;

const itemCommon = {
  id: ItemId,
  /** Shown only when true. Evaluated with null-safe semantics. */
  showIf: Expression.optional(),
  variants: Variants.optional(),
};

export const Question = z.strictObject({
  ...itemCommon,
  kind: z.literal('question'),
  name: VariableName,
  type: QuestionType,
  text: LocalizedText,
  /** Defaults to true: a required question needs an answer, DK or Refused to proceed. */
  required: z.boolean().optional(),
  /** Marks the answer as personal data (masked and excluded from exports without PII permission). */
  personal: z.boolean().optional(),

  // choice questions
  options: z.array(AnswerOption).optional(),
  answerSetId: z.string().optional(),
  randomizeOptions: z.boolean().optional(),
  /** Options are shown only when this is true; `code` refers to the option being tested. */
  optionFilter: Expression.optional(),
  minSelections: z.number().int().min(0).optional(),
  maxSelections: z.number().int().min(1).optional(),

  // grid
  rows: z.array(z.strictObject({ code: Code, label: LocalizedText })).optional(),

  // numeric / scale
  min: z.number().optional(),
  max: z.number().optional(),
  decimals: z.number().int().min(0).max(10).optional(),
  unit: LocalizedText.optional(),
  scale: z
    .strictObject({
      style: z.enum(['likert', 'nps', 'slider']),
      min: z.number(),
      max: z.number(),
      step: z.number().positive().optional(),
      minLabel: LocalizedText.optional(),
      maxLabel: LocalizedText.optional(),
      /**
       * Optional colours for the points: `diverging` goes red → amber → green, `sequential`
       * light → dark, `nps` marks detractors (0–6), passives (7–8) and promoters (9–10).
       */
      palette: z.enum(['diverging', 'sequential', 'nps']).optional(),
    })
    .optional(),

  // text
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().optional(),

  // date / time (ISO strings or expressions)
  minDate: z.string().optional(),
  maxDate: z.string().optional(),

  // special codes
  allowDK: z.boolean().optional(),
  allowRefused: z.boolean().optional(),

  // logic
  prefill: Expression.optional(),
  validations: z.array(ValidationRule).optional(),
  skips: z.array(SkipRule).optional(),
  endIf: z.array(EndRule).optional(),
});
export type Question = z.infer<typeof Question>;

export const StaticText = z.strictObject({
  ...itemCommon,
  kind: z.literal('static'),
  text: LocalizedText,
  /** consent/instruction blocks; `consent` requires an explicit acknowledgment. */
  role: z.enum(['instruction', 'consent', 'info']).optional(),
});
export type StaticText = z.infer<typeof StaticText>;

export const ComputedValueType = z.enum(['number', 'string', 'boolean', 'date', 'code']);
export type ComputedValueType = z.infer<typeof ComputedValueType>;

export const Computed = z.strictObject({
  id: ItemId,
  kind: z.literal('computed'),
  name: VariableName,
  formula: Expression,
  valueType: ComputedValueType,
  showIf: Expression.optional(),
});
export type Computed = z.infer<typeof Computed>;

export const PageBreak = z.strictObject({
  id: ItemId,
  kind: z.literal('pagebreak'),
});
export type PageBreak = z.infer<typeof PageBreak>;

export type LeafItem = Question | StaticText | Computed | PageBreak;

export interface Block {
  kind: 'block';
  id: string;
  title?: LocalizedText;
  showIf?: string;
  items: ContainerItem[];
}

export type RosterCount =
  | { type: 'fixed'; n: number }
  | { type: 'expression'; expr: string; max?: number }
  | { type: 'open'; max?: number };

export interface Roster {
  kind: 'roster';
  id: string;
  /** Variable under which rows are stored as an array of objects. */
  name: string;
  title?: LocalizedText;
  showIf?: string;
  count: RosterCount;
  /** Expression used to label each row in navigators, e.g. `NAME`. */
  rowLabel?: string;
  items: ContainerItem[];
}

export type ContainerItem = LeafItem | Block | Roster;

const RosterCountSchema: z.ZodType<RosterCount> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('fixed'), n: z.number().int().min(0).max(500) }),
  z.strictObject({
    type: z.literal('expression'),
    expr: Expression,
    max: z.number().int().min(1).max(500).optional(),
  }),
  z.strictObject({ type: z.literal('open'), max: z.number().int().min(1).max(500).optional() }),
]);

export const ContainerItemSchema: z.ZodType<ContainerItem> = z.lazy(() =>
  z.union([Question, StaticText, Computed, PageBreak, BlockSchema, RosterSchema]),
);

export const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.strictObject({
    kind: z.literal('block'),
    id: ItemId,
    title: LocalizedText.optional(),
    showIf: Expression.optional(),
    items: z.array(ContainerItemSchema),
  }),
);

export const RosterSchema: z.ZodType<Roster> = z.lazy(() =>
  z.strictObject({
    kind: z.literal('roster'),
    id: ItemId,
    name: VariableName,
    title: LocalizedText.optional(),
    showIf: Expression.optional(),
    count: RosterCountSchema,
    rowLabel: Expression.optional(),
    items: z.array(ContainerItemSchema),
  }),
);

export const Section = z.strictObject({
  id: ItemId,
  title: LocalizedText,
  showIf: Expression.optional(),
  items: z.array(ContainerItemSchema),
});
export type Section = z.infer<typeof Section>;

// ---------------------------------------------------------------------------
// Scripts, quotas, questionnaire
// ---------------------------------------------------------------------------

export const ScriptAnchor = z.discriminatedUnion('at', [
  z.strictObject({ at: z.literal('start') }),
  z.strictObject({ at: z.literal('end') }),
  z.strictObject({ at: z.literal('section'), sectionId: z.string() }),
  z.strictObject({ at: z.literal('item'), itemId: z.string() }),
  z.strictObject({
    at: z.literal('callOutcome'),
    outcome: z.enum([
      'busy',
      'refusal',
      'callback',
      'voicemail',
      'answered',
      'no_answer',
      'wrong_number',
    ]),
  }),
]);

export const Script = z.strictObject({
  id: z.string().min(1),
  anchor: ScriptAnchor,
  modes: z.array(z.enum(['CATI', 'CAPI', 'PAPI'])).min(1),
  /** Rich text (sanitised HTML subset) per language, with piping. */
  body: LocalizedText,
});
export type Script = z.infer<typeof Script>;

export const Quota = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Membership condition for the cell, e.g. `AGE_GROUP == 3`. */
  when: Expression,
  max: z.number().int().min(0),
  disposition: Disposition.default('QUOTA_FULL'),
});
export type Quota = z.infer<typeof Quota>;

export const QuestionnaireSettings = z.strictObject({
  specialCodes: SpecialCodes.default(DEFAULT_SPECIAL_CODES),
  /** CAWI respondents only see DK/Refused when enabled. */
  cawiShowSpecialCodes: z.boolean().default(false),
});
export type QuestionnaireSettings = z.infer<typeof QuestionnaireSettings>;

export const Questionnaire = z.strictObject({
  id: ItemId,
  title: LocalizedText,
  defaultLanguage: LanguageCode,
  languages: z.array(LanguageCode).min(1),
  /**
   * The modes this questionnaire is fielded in, chosen when it is created (Q1): mode variants,
   * the preview, interviews, web waves and paper forms are limited to them. Definitions
   * written before the field existed are taken as all four.
   */
  modes: z
    .array(Mode)
    .min(1)
    .refine((m) => new Set(m).size === m.length, { message: 'Each mode once' })
    .default([...MODES]),
  settings: QuestionnaireSettings.default({
    specialCodes: DEFAULT_SPECIAL_CODES,
    cawiShowSpecialCodes: false,
  }),
  answerSets: z.record(z.string(), z.array(AnswerOption)).default({}),
  sections: z.array(Section).min(1),
  scripts: z.array(Script).default([]),
  quotas: z.array(Quota).default([]),
});
export type Questionnaire = z.infer<typeof Questionnaire>;
export type QuestionnaireInput = z.input<typeof Questionnaire>;
