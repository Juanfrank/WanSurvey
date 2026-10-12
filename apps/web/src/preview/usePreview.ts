import { SAMPLES } from '@wansurvey/fixtures';
import {
  analyze,
  compile,
  createInterview,
  interviewOutcome,
  type CompiledQuestionnaire,
  type Diagnostic,
  type InterviewContext,
  type InterviewSession,
} from '@wansurvey/logic';
import { Questionnaire, type AnswerValue, type Mode, type Scenario } from '@wansurvey/schema';
import { useCallback, useMemo, useState } from 'react';

export type Source = { kind: 'sample'; id: string } | { kind: 'json'; text: string; name: string };

export interface Loaded {
  questionnaire: Questionnaire | null;
  /** Zod format problems, when the JSON is not a questionnaire at all. */
  schemaIssues: string[];
  jsonError: string | null;
  diagnostics: Diagnostic[];
  compiled: CompiledQuestionnaire | null;
}

export type Step = Scenario['steps'][number];

const todayIso = () => new Date().toISOString().slice(0, 10);

export const DEFAULT_CONTEXT: InterviewContext = {
  case: { city: 'Lima', region: 1 },
  respondent: { firstName: 'Rosa' },
  interviewer: { firstName: 'Juan' },
};

/** Validates (Zod), analyses and compiles a questionnaire in the browser. */
export function loadSource(source: Source): Loaded {
  const empty: Loaded = {
    questionnaire: null,
    schemaIssues: [],
    jsonError: null,
    diagnostics: [],
    compiled: null,
  };
  let raw: unknown;
  if (source.kind === 'sample') {
    raw = SAMPLES.find((s) => s.id === source.id)?.questionnaire;
  } else {
    try {
      raw = JSON.parse(source.text);
    } catch (e) {
      return { ...empty, jsonError: (e as Error).message };
    }
  }
  const parsed = Questionnaire.safeParse(raw);
  if (!parsed.success) {
    return {
      ...empty,
      schemaIssues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const { diagnostics, canPublish } = analyze(parsed.data);
  return {
    ...empty,
    questionnaire: parsed.data,
    diagnostics,
    compiled: canPublish ? compile(parsed.data) : null,
  };
}

export interface RunOptions {
  mode: Mode;
  language: string;
  today: string;
  context: InterviewContext;
  quotasFull: string[];
}

function newSession(
  compiled: CompiledQuestionnaire,
  o: RunOptions,
  from?: InterviewSession,
): InterviewSession {
  const full = new Set(o.quotasFull);
  return createInterview(compiled, {
    mode: o.mode,
    language: o.language,
    context: o.context,
    now: () => new Date(`${o.today}T12:00:00Z`),
    seed: 'preview',
    quotas: { isFull: (id) => full.has(id) },
    ...(from ? { state: { ...from.state(), language: o.language } } : {}),
  });
}

/**
 * State of the designer's test mode. Changing mode, date, context or quotas keeps the
 * answers given so far (the interview is rebuilt from its state), so one run can be
 * inspected in every mode.
 */
export function usePreview() {
  const [source, setSourceState] = useState<Source>({ kind: 'sample', id: SAMPLES[0]!.id });
  const loaded = useMemo(() => loadSource(source), [source]);
  const [options, setOptions] = useState<RunOptions>({
    mode: 'CATI',
    language: loaded.questionnaire?.defaultLanguage ?? 'en',
    today: todayIso(),
    context: DEFAULT_CONTEXT,
    quotasFull: [],
  });
  const [session, setSession] = useState<InterviewSession | null>(() =>
    loaded.compiled ? newSession(loaded.compiled, options) : null,
  );
  const [steps, setSteps] = useState<Step[]>([]);
  const [rev, setRev] = useState(0);

  const setSource = useCallback(
    (s: Source) => {
      const next = loadSource(s);
      const opts = {
        ...options,
        language: next.questionnaire?.defaultLanguage ?? 'en',
        quotasFull: [],
      };
      setSourceState(s);
      setOptions(opts);
      setSession(next.compiled ? newSession(next.compiled, opts) : null);
      setSteps([]);
      setRev((r) => r + 1);
    },
    [options],
  );

  const update = useCallback(
    (patch: Partial<RunOptions>) => {
      const opts = { ...options, ...patch };
      setOptions(opts);
      if (loaded.compiled) setSession(newSession(loaded.compiled, opts, session ?? undefined));
      setRev((r) => r + 1);
    },
    [options, loaded.compiled, session],
  );

  const reset = useCallback(() => {
    if (loaded.compiled) setSession(newSession(loaded.compiled, options));
    setSteps([]);
    setRev((r) => r + 1);
  }, [loaded.compiled, options]);

  /** Called after every change in the runner: records what the person did, for scenarios. */
  const onChange = useCallback(() => {
    if (!session) return;
    const recorded: Step[] = [];
    for (const e of session.drainEvents()) {
      if (e.source === 'system') continue;
      if (e.reason === 'roster_resized') recorded.push({ addRow: e.key.replace(/\[\d+\]$/, '') });
      else if (!e.reason) recorded.push({ answer: e.key, value: e.newValue as AnswerValue });
    }
    if (recorded.length) setSteps((s) => [...s, ...recorded]);
    setRev((r) => r + 1);
  }, [session]);

  /** Snapshot of this run as a regression scenario. */
  const toScenario = useCallback(
    (name: string): Scenario | null => {
      if (!session) return null;
      const ended = session.endState();
      const answers: Record<string, AnswerValue> = {};
      for (const e of session.path())
        if (e.kind === 'question') answers[e.key] = session.getAnswer(e.key);
      return {
        name,
        mode: options.mode,
        language: options.language,
        context: options.context as Scenario['context'],
        today: options.today,
        quotasFull: options.quotasFull,
        steps,
        expect: {
          outcome: interviewOutcome(session),
          ...(ended ? { disposition: ended.disposition } : {}),
          pathIncludes: session.pathKeys(),
          answers,
        },
      };
    },
    [session, options, steps],
  );

  return {
    source,
    setSource,
    loaded,
    options,
    update,
    session,
    reset,
    onChange,
    rev,
    steps,
    toScenario,
  };
}
