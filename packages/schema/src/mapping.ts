import { z } from 'zod';
import { VariableName } from './common.js';

/** What to do with data collected under the previous version for one breaking change. */
export const MappingAction = z.discriminatedUnion('action', [
  /** The variable now lives under another name. */
  z.strictObject({ action: z.literal('rename'), to: VariableName }),
  /** Old code → new code; null discards answers with that code. Keys are the old codes as text. */
  z.strictObject({
    action: z.literal('recode'),
    map: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  }),
  /** Keep the old data in its version only; it does not carry over. */
  z.strictObject({ action: z.literal('drop') }),
]);
export type MappingAction = z.infer<typeof MappingAction>;

/**
 * Explicit mapping from the previous published version, keyed by breaking-change id
 * (e.g. `removed:Q5`, `codes:Q7`). Required at publish when a version breaks data compatibility.
 */
export const VersionMapping = z.record(z.string(), MappingAction);
export type VersionMapping = z.infer<typeof VersionMapping>;
