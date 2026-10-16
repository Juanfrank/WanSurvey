import {
  createInterview,
  own,
  runScenario,
  type CompiledQuestionnaire,
  type Diagnostic,
  type InterviewSession,
  type ScenarioResult,
} from '@wansurvey/logic';
import { pick } from '@wansurvey/renderer';
import { MODES, Scenario, type Question, type StaticText } from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunOptions } from './usePreview.js';
import { localiseCheck, localiseDiagnostic } from '../i18n-messages.js';

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-ink-900',
  hidden: 'bg-slate-200 text-slate-800',
  skipped: 'bg-amber-100 text-amber-ink-900',
  notInMode: 'bg-violet-100 text-violet-ink-900',
  ended: 'bg-red-100 text-red-ink-900',
};

export function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const { t } = useTranslation();
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  return (
    <section aria-labelledby="diag-h" className="flex flex-col gap-2">
      <h2 id="diag-h" className="font-semibold">
        {t('preview.diagnostics')}
      </h2>
      {diagnostics.length === 0 ? (
        <p className="text-sm text-emerald-ink-800">{t('preview.noIssues')}</p>
      ) : null}
      {errors.length ? (
        <p className="text-sm font-medium text-red-ink-800">
          {t('preview.errorsCount', { count: errors.length })}
        </p>
      ) : null}
      {warnings.length ? (
        <p className="text-sm text-amber-ink-900">
          {t('preview.warningsCount', { count: warnings.length })}
        </p>
      ) : null}
      {diagnostics.length ? (
        <ul className="max-h-48 overflow-auto rounded-md border border-slate-200 bg-white text-sm">
          {diagnostics.map((d, i) => (
            <li key={i} className="flex gap-2 border-b border-slate-100 px-3 py-1.5 last:border-0">
              <span
                className={
                  d.severity === 'error' ? 'font-semibold text-red-ink-800' : 'text-amber-ink-900'
                }
              >
                {d.severity === 'error' ? '✕' : '!'}
              </span>
              {d.itemId ? <span className="font-mono text-slate-600">{d.itemId}</span> : null}
              <span>{localiseDiagnostic(t, d)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function valuePreview(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v !== null && '$special' in v)
    return (v as { $special: string }).$special;
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** Every item with its status and the reason for it; answered items can be jumped to. */
export function PathTracer({
  session,
  onJump,
}: {
  session: InterviewSession;
  onJump(key: string): void;
}) {
  const { t } = useTranslation();
  const current = session.currentKey();
  return (
    <section aria-labelledby="tracer-h" className="flex flex-col gap-2">
      <h2 id="tracer-h" className="font-semibold">
        {t('preview.tracer')}
      </h2>
      <p className="text-sm text-slate-600">{t('preview.tracerHelp')}</p>
      <ol
        className="max-h-[32rem] overflow-auto rounded-md border border-slate-200 bg-white text-sm"
        data-testid="tracer"
      >
        {session.trace().map((e) => {
          const jumpable =
            e.status === 'active' &&
            (e.kind === 'question' || e.kind === 'static') &&
            session.canJumpTo(e.key);
          const value =
            e.kind === 'question' || e.kind === 'computed'
              ? valuePreview(session.getAnswer(e.key))
              : '';
          const body = (
            <>
              <span className="flex items-center gap-2">
                <span className="font-mono">{e.key}</span>
                <span className={`rounded px-1.5 text-xs ${STATUS_STYLE[e.status]}`}>
                  {t(`preview.status.${e.status}`)}
                </span>
                {e.key === current ? (
                  <span className="rounded bg-indigo-600 px-1.5 text-xs text-on-fill">
                    {t('preview.current')}
                  </span>
                ) : null}
                {value ? (
                  <span className="ml-auto truncate font-mono text-slate-700">{value}</span>
                ) : null}
              </span>
              <span className="block text-xs text-slate-600">
                {e.why
                  ? t(`preview.why.${e.why.code}`, {
                      ...e.why.params,
                      count: Number(e.why.params.n ?? 0),
                      defaultValue: e.reason,
                    })
                  : e.reason}
              </span>
            </>
          );
          return (
            <li
              key={`${e.key}:${e.id}`}
              data-status={e.status}
              data-key={e.key}
              className="border-b border-slate-100 last:border-0"
              style={{ paddingLeft: `${0.75 + e.depth * 0.75}rem` }}
            >
              {jumpable ? (
                <button
                  type="button"
                  className="block w-full py-1.5 pr-3 text-left hover:bg-indigo-50"
                  onClick={() => onJump(e.key)}
                >
                  {body}
                </button>
              ) : (
                <div className="py-1.5 pr-3">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The current item as each mode presents it, flagging wording that differs from the base text. */
export function ComparePanel({
  session,
  compiled,
  options,
}: {
  session: InterviewSession;
  compiled: CompiledQuestionnaire;
  options: RunOptions;
}) {
  const { t } = useTranslation();
  const key = session.currentKey() ?? session.path()[0]?.key;
  const entry = key ? session.trace().find((e) => e.key === key) : undefined;
  if (!key || !entry) return null;
  const def = compiled.nodes[own(compiled.byId, entry.id)!]!.def as Question | StaticText;
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-slate-600">{t('preview.compareHelp')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {(compiled.questionnaire.modes?.length ? compiled.questionnaire.modes : MODES).map(
          (mode) => {
            const s = createInterview(compiled, {
              mode,
              language: options.language,
              context: options.context,
              now: () => new Date(`${options.today}T12:00:00Z`),
              state: session.state(),
            });
            const inMode = s.trace().find((e) => e.key === key);
            const variant = def.variants?.[mode];
            const differs = !!variant?.text;
            return (
              <article
                key={mode}
                className="rounded-lg border border-slate-200 bg-white p-4"
                data-compare-mode={mode}
              >
                <h3 className="mb-2 flex items-center gap-2 font-semibold">
                  {mode}
                  <span
                    className={`rounded px-1.5 text-xs ${differs ? 'bg-amber-100 text-amber-ink-900' : 'bg-slate-100 text-slate-700'}`}
                  >
                    {differs ? t('preview.differs') : t('preview.base')}
                  </span>
                </h3>
                {inMode?.status === 'notInMode' ? (
                  <p className="text-sm italic text-slate-600">{t('preview.hiddenInMode')}</p>
                ) : (
                  <>
                    <p>{s.text(key) ?? pick(def.text, options.language)}</p>
                    {mode !== 'CAWI' && s.text(key, 'interviewerInstruction') ? (
                      <p className="mt-2 text-sm font-semibold uppercase text-amber-ink-900">
                        {s.text(key, 'interviewerInstruction')}
                      </p>
                    ) : null}
                  </>
                )}
              </article>
            );
          },
        )}
      </div>
    </section>
  );
}

export function AnswersPanel({ session }: { session: InterviewSession }) {
  const { t } = useTranslation();
  const answers = session.getAnswers();
  if (Object.keys(answers).length === 0)
    return <p className="text-slate-600">{t('preview.noAnswers')}</p>;
  return (
    <pre
      className="max-h-[32rem] overflow-auto rounded-md border border-slate-200 bg-white p-3 text-sm"
      data-testid="answers-json"
    >
      {JSON.stringify(answers, null, 2)}
    </pre>
  );
}

const storageKey = (id: string) => `ws.scenarios.${id}`;

function loadScenarios(id: string): Scenario[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(id)) ?? '[]');
    return (Array.isArray(raw) ? raw : []).flatMap((s) => {
      const r = Scenario.safeParse(s);
      return r.success ? [r.data] : [];
    });
  } catch {
    return [];
  }
}

function saveScenarios(id: string, list: Scenario[]) {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(list));
  } catch {
    /* storage unavailable: scenarios can still be downloaded */
  }
}

/** Where saved scenarios live: the browser for the sample preview, the API in the designer. */
export interface ScenarioStore {
  list: Scenario[];
  save(s: Scenario): void | Promise<void>;
  remove(s: Scenario): void | Promise<void>;
}

/** Scenarios kept in this browser, per questionnaire id. */
export function useLocalScenarios(questionnaireId: string): ScenarioStore {
  const [state, setState] = useState(() => ({
    id: questionnaireId,
    list: loadScenarios(questionnaireId),
  }));
  if (state.id !== questionnaireId) {
    setState({ id: questionnaireId, list: loadScenarios(questionnaireId) });
  }
  const list = state.id === questionnaireId ? state.list : [];
  const store = (next: Scenario[]) => {
    setState({ id: questionnaireId, list: next });
    saveScenarios(questionnaireId, next);
  };
  return {
    list,
    save: (s) => store([...list.filter((x) => x.name !== s.name), s]),
    remove: (s) => store(list.filter((x) => x.name !== s.name)),
  };
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Saved runs that act as regression tests for the questionnaire. */
export function ScenariosPanel({
  store,
  compiled,
  toScenario,
  help,
}: {
  store: ScenarioStore;
  compiled: CompiledQuestionnaire;
  /** Snapshot of the current run; omitted where there is no run to save. */
  toScenario?(name: string): Scenario | null;
  help?: string;
}) {
  const { t } = useTranslation();
  const list = store.list;
  const [results, setResults] = useState<Record<string, ScenarioResult>>({});
  const [name, setName] = useState('');
  const run = (s: Scenario) =>
    setResults((r) => {
      let result: ScenarioResult;
      try {
        result = runScenario(compiled, s);
      } catch (e) {
        result = {
          name: s.name,
          passed: false,
          checks: [{ label: 'run', passed: false, detail: (e as Error).message }],
        } as unknown as ScenarioResult;
      }
      return { ...r, [s.name]: result };
    });

  return (
    <section aria-labelledby="scen-h" className="flex flex-col gap-3">
      <h2 id="scen-h" className="font-semibold">
        {t('preview.scenarios')}
      </h2>
      <p className="text-sm text-slate-600">{help ?? t('preview.scenariosHelp')}</p>
      {toScenario ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const s = toScenario(name.trim() || t('preview.runDefault', { n: list.length + 1 }));
            if (!s) return;
            void store.save(s);
            setName('');
          }}
        >
          <label className="sr-only" htmlFor="scenario-name">
            {t('preview.scenarioName')}
          </label>
          <input
            id="scenario-name"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
            placeholder={t('preview.scenarioName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-on-fill hover:bg-indigo-700"
          >
            {t('preview.saveScenario')}
          </button>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
          onClick={() => list.forEach(run)}
          disabled={!list.length}
        >
          {t('preview.runAll')}
        </button>
        <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50">
          {t('preview.upload')}
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const r = Scenario.safeParse(JSON.parse(await file.text()));
              if (r.success) void store.save(r.data);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-slate-600">{t('preview.noScenarios')}</p>
      ) : null}
      <ul className="flex flex-col gap-2" data-testid="scenarios">
        {list.map((s) => {
          const r = results[s.name];
          return (
            <li key={s.name} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <span className="text-slate-500">· {s.mode}</span>
                {r ? (
                  <span
                    className={`rounded px-1.5 text-xs ${r.passed ? 'bg-emerald-100 text-emerald-ink-900' : 'bg-red-100 text-red-ink-900'}`}
                    data-result={r.passed ? 'passed' : 'failed'}
                  >
                    {r.passed ? t('preview.passed') : t('preview.failed')}
                  </span>
                ) : null}
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 hover:bg-slate-50"
                    onClick={() => run(s)}
                  >
                    {t('preview.run')}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 hover:bg-slate-50"
                    onClick={() => download(`${s.name}.scenario.json`, s)}
                  >
                    {t('preview.download')}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 hover:bg-slate-50"
                    onClick={() => void store.remove(s)}
                  >
                    {t('preview.remove')}
                  </button>
                </span>
              </div>
              {r && !r.passed ? (
                <ul className="mt-2 list-disc pl-5 text-red-ink-900">
                  {r.checks
                    .filter((c) => !c.passed)
                    .map((c, i) => (
                      <li key={i}>
                        {localiseCheck(t, c)}
                        {c.detail && !c.msg ? (
                          <span className="text-slate-600"> — {c.detail}</span>
                        ) : null}
                      </li>
                    ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
