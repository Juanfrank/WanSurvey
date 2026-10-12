import { z } from 'zod';

/** How cases reach interviewers: handed out by a supervisor or rules, or claimed from a pool. */
export const ASSIGNMENT_MODES = ['assigned', 'pool'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

/** Per-project settings, stored as jsonb on `projects.settings`. Missing keys take defaults. */
export const ProjectSettings = z.object({
  /**
   * Interviewers with `pii.view` see the personal data of their own cases without asking;
   * the first view of each case is recorded in the audit log.
   */
  revealToInterviewers: z.boolean().default(true),
  /** `pool`: unassigned cases are open to every interviewer, and the first to claim one holds it. */
  assignmentMode: z.enum(ASSIGNMENT_MODES).default('assigned'),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** Settings with defaults filled in, from whatever is stored. */
export function projectSettings(stored: unknown): ProjectSettings {
  const parsed = ProjectSettings.safeParse(stored ?? {});
  return parsed.success ? parsed.data : ProjectSettings.parse({});
}
