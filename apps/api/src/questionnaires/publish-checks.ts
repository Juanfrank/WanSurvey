import {
  analyze,
  breakingChanges,
  compile,
  questionnaireHash,
  runScenario,
  validateMapping,
  type BreakingChange,
  type CompiledQuestionnaire,
  type Diagnostic,
  type MappingProblem,
} from '@wansurvey/logic';
import { Questionnaire, Scenario, type VersionMapping } from '@wansurvey/schema';

export interface ScenarioOutcome {
  id: string;
  name: string;
  passed: boolean;
  checks: { label: string; passed: boolean; detail?: string }[];
}

export interface PublishCheck {
  /** True when nothing blocks publishing. */
  ok: boolean;
  /** Zod format problems; when present nothing else is checked. */
  schemaIssues: { path: string; message: string }[];
  diagnostics: Diagnostic[];
  scenarios: ScenarioOutcome[];
  breaking: BreakingChange[];
  mappingProblems: MappingProblem[];
  /** The draft is identical to the latest published version. */
  unchanged: boolean;
  previousVersion: number | null;
}

export interface PreviousVersion {
  version: number;
  definition: unknown;
  hash: string;
}

/**
 * Everything that must hold before a draft becomes a version (spec §4.4, §5.3): valid format,
 * no analyzer errors, every saved scenario passing, and a complete mapping for breaking changes.
 */
export function checkDraft(
  draft: unknown,
  scenarios: { id: string; name: string; scenario: unknown }[],
  previous: PreviousVersion | null,
  mapping: VersionMapping | undefined,
): { check: PublishCheck; questionnaire?: Questionnaire; compiled?: CompiledQuestionnaire } {
  const empty: PublishCheck = {
    ok: false,
    schemaIssues: [],
    diagnostics: [],
    scenarios: [],
    breaking: [],
    mappingProblems: [],
    unchanged: false,
    previousVersion: previous?.version ?? null,
  };
  const parsed = Questionnaire.safeParse(draft);
  if (!parsed.success) {
    return {
      check: {
        ...empty,
        schemaIssues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    };
  }
  const q = parsed.data;
  const { diagnostics, canPublish } = analyze(q);
  const compiled = canPublish ? compile(q) : undefined;

  const outcomes: ScenarioOutcome[] = scenarios.map((s) => {
    const sc = Scenario.safeParse(s.scenario);
    if (!sc.success) {
      return {
        id: s.id,
        name: s.name,
        passed: false,
        checks: [{ label: 'format', passed: false, detail: 'The scenario is not valid' }],
      };
    }
    if (!compiled) {
      return {
        id: s.id,
        name: s.name,
        passed: false,
        checks: [{ label: 'run', passed: false, detail: 'Fix the questionnaire errors first' }],
      };
    }
    try {
      const r = runScenario(compiled, sc.data);
      return { id: s.id, name: s.name, passed: r.passed, checks: r.checks };
    } catch (e) {
      return {
        id: s.id,
        name: s.name,
        passed: false,
        checks: [{ label: 'run', passed: false, detail: (e as Error).message }],
      };
    }
  });

  let breaking: BreakingChange[] = [];
  let mappingProblems: MappingProblem[] = [];
  let unchanged = false;
  if (previous) {
    const prevQ = Questionnaire.parse(previous.definition);
    unchanged = questionnaireHash(q) === previous.hash;
    breaking = breakingChanges(prevQ, q);
    mappingProblems = validateMapping(breaking, mapping, prevQ, q);
  }

  const check: PublishCheck = {
    ...empty,
    diagnostics,
    scenarios: outcomes,
    breaking,
    mappingProblems,
    unchanged,
    ok: canPublish && outcomes.every((o) => o.passed) && mappingProblems.length === 0 && !unchanged,
  };
  return { check, questionnaire: q, ...(compiled ? { compiled } : {}) };
}
