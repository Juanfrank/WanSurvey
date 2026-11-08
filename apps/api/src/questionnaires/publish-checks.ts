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

/**
 * Whether a questionnaire opens with an information notice: before any question there is a text
 * with the role "consent", and the first question refuses to go on (it ends the interview as a
 * refusal). Projects can require this before publishing.
 */
export function hasNotice(q: Questionnaire): boolean {
  let consent = false;
  let found: boolean | null = null;
  const walk = (items: readonly unknown[]) => {
    for (const raw of items) {
      if (found !== null) return;
      const it = raw as {
        kind: string;
        role?: string;
        endIf?: { disposition?: string }[];
        items?: unknown[];
      };
      if (it.kind === 'static' && it.role === 'consent') consent = true;
      else if (it.kind === 'question')
        found = consent && (it.endIf ?? []).some((e) => e.disposition === 'REFUSAL');
      else if (Array.isArray(it.items)) walk(it.items);
    }
  };
  for (const s of q.sections) {
    walk(s.items);
    if (found !== null) break;
  }
  return found === true;
}

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
