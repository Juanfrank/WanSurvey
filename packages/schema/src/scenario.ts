import { z } from 'zod';
import { Mode } from './common.js';
import { AnswerValueSchema } from './interview.js';

/**
 * A saved test run of a questionnaire: answers given in order and the outcomes they must
 * produce. Saved from the designer's test mode and re-run on every publish.
 */
export const Scenario = z.object({
  name: z.string().min(1).max(200),
  mode: Mode,
  language: z.string().optional(),
  /** Fake sample data, interviewer and respondent profiles. */
  context: z
    .object({
      case: z.record(z.string(), z.unknown()).optional(),
      interviewer: z.record(z.string(), z.unknown()).optional(),
      respondent: z.record(z.string(), z.unknown()).optional(),
      project: z.record(z.string(), z.unknown()).optional(),
    })
    .default({}),
  /** Date used by today(), ISO `YYYY-MM-DD`. */
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Quota ids treated as full. */
  quotasFull: z.array(z.string()).default([]),
  steps: z
    .array(
      z.union([
        z.object({ answer: z.string(), value: AnswerValueSchema }),
        z.object({ addRow: z.string() }),
      ]),
    )
    .max(5000),
  expect: z
    .object({
      pathIncludes: z.array(z.string()).optional(),
      pathExcludes: z.array(z.string()).optional(),
      /** complete: every question on the path is answered without errors. */
      outcome: z.enum(['complete', 'incomplete', 'ended']).optional(),
      disposition: z.string().optional(),
      /** Final answer values; null means the key must be unanswered. */
      answers: z.record(z.string(), AnswerValueSchema).optional(),
      /** Keys that must have been cleared by a path change at some step. */
      cleared: z.array(z.string()).optional(),
      /** Validation errors that must be present at the end. */
      errors: z.array(z.object({ key: z.string(), ruleId: z.string() })).optional(),
    })
    .default({}),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;
