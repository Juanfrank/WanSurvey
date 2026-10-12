import type { AnswerValue, Scenario } from '@wansurvey/schema';
import type { CompiledQuestionnaire } from './compile.js';
import { createInterview, type InterviewSession } from './engine.js';
import type { MessageRef } from './typecheck.js';
import { isAnswered, type Value } from './values.js';

export interface ScenarioCheck {
  /** English label; `msg` identifies the translatable one (`scenario.<id>`). */
  label: string;
  passed: boolean;
  detail?: string;
  msg?: MessageRef;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  checks: ScenarioCheck[];
  /** The session after the run, for inspection (path tracer). */
  session: InterviewSession;
}

/** complete = every question on the path is answered and passes its hard checks. */
export function interviewOutcome(s: InterviewSession): 'complete' | 'incomplete' | 'ended' {
  if (s.endState()) return 'ended';
  const ok = s
    .path()
    .filter((e) => e.kind === 'question')
    .every((e) => s.validate(e.key).errors.length === 0);
  return ok ? 'complete' : 'incomplete';
}

const show = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Replays a saved scenario against a compiled questionnaire and checks its expectations.
 * Deterministic: the clock, quotas and randomisation seed all come from the scenario.
 */
export function runScenario(compiled: CompiledQuestionnaire, scenario: Scenario): ScenarioResult {
  const full = new Set(scenario.quotasFull);
  const session = createInterview(compiled, {
    mode: scenario.mode,
    ...(scenario.language ? { language: scenario.language } : {}),
    context: scenario.context,
    now: () => new Date(`${scenario.today ?? '2026-01-01'}T12:00:00Z`),
    seed: `scenario:${scenario.name}`,
    quotas: { isFull: (id) => full.has(id) },
  });
  const checks: ScenarioCheck[] = [];
  const cleared = new Set<string>();

  scenario.steps.forEach((step, i) => {
    if ('addRow' in step) {
      try {
        session.addRosterRow(step.addRow);
      } catch (e) {
        checks.push({
          label: `step ${i + 1}: add row to ${step.addRow}`,
          msg: { id: 'add_row', params: { n: i + 1, name: step.addRow } },
          passed: false,
          detail: (e as Error).message,
        });
      }
      return;
    }
    const r = session.setAnswer(step.answer, step.value as AnswerValue);
    if (!r.ok) {
      checks.push({
        label: `step ${i + 1}: answer ${step.answer}`,
        msg: { id: 'answer', params: { n: i + 1, name: step.answer } },
        passed: false,
        detail: r.error,
      });
    }
    r.cleared.forEach((c) => cleared.add(c.key));
  });

  const e = scenario.expect;
  const path = new Set(session.pathKeys());
  for (const k of e.pathIncludes ?? []) {
    checks.push({
      label: `${k} is on the path`,
      passed: path.has(k),
      msg: { id: 'on_path', params: { name: k } },
    });
  }
  for (const k of e.pathExcludes ?? []) {
    checks.push({
      label: `${k} is not on the path`,
      passed: !path.has(k),
      msg: { id: 'not_on_path', params: { name: k } },
    });
  }
  if (e.outcome) {
    const actual = interviewOutcome(session);
    checks.push({
      label: `outcome is ${e.outcome}`,
      msg: { id: 'outcome', params: { expected: e.outcome, got: String(actual) } },
      passed: actual === e.outcome,
      detail: `got ${actual}`,
    });
  }
  if (e.disposition) {
    const actual =
      session.endState()?.disposition ??
      (interviewOutcome(session) === 'complete' ? 'COMPLETE' : null);
    checks.push({
      label: `disposition is ${e.disposition}`,
      msg: { id: 'disposition', params: { expected: e.disposition, got: String(actual) } },
      passed: actual === e.disposition,
      detail: `got ${actual}`,
    });
  }
  for (const [k, expected] of Object.entries(e.answers ?? {})) {
    const actual = session.getAnswer(k);
    const passed =
      expected === null
        ? !isAnswered(actual as Value)
        : JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({
      label: `${k} = ${show(expected)}`,
      passed,
      detail: `got ${show(actual)}`,
      msg: { id: 'answer_is', params: { name: k, expected: show(expected), got: show(actual) } },
    });
  }
  for (const k of e.cleared ?? []) {
    checks.push({
      label: `${k} was cleared by a path change`,
      passed: cleared.has(k),
      msg: { id: 'cleared', params: { name: k } },
    });
  }
  for (const { key, ruleId } of e.errors ?? []) {
    const errors = session.validate(key).errors.map((x) => x.ruleId);
    checks.push({
      label: `${key} fails ${ruleId}`,
      msg: { id: 'fails', params: { name: key, rule: ruleId, got: errors.join(', ') || '—' } },
      passed: errors.includes(ruleId),
      detail: `errors: ${errors.join(', ') || 'none'}`,
    });
  }
  return { name: scenario.name, passed: checks.every((c) => c.passed), checks, session };
}
