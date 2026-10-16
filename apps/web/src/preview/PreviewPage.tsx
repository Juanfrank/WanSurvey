import * as Tabs from '@radix-ui/react-tabs';
import { SAMPLES } from '@wansurvey/fixtures';
import { InterviewRunner, PaperForm, pick } from '@wansurvey/renderer';
import { MODES, type Mode } from '@wansurvey/schema';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../routes/ui.js';
import {
  AnswersPanel,
  ComparePanel,
  DiagnosticsPanel,
  PathTracer,
  ScenariosPanel,
  useLocalScenarios,
  type ScenarioStore,
} from './panels.js';
import { usePreview } from './usePreview.js';
import { AsSeenFrame } from './AsSeen.js';

const selectCls = 'max-w-full rounded-md border border-slate-300 bg-white px-2 py-1.5';

/** The designer's test mode: run any questionnaire in every mode and see why the path goes where it goes. */
export function PreviewPage() {
  const { t, i18n } = useTranslation();
  const p = usePreview();
  const [paste, setPaste] = useState('');
  const q = p.loaded.questionnaire;
  const scenarios = useLocalScenarios(q?.id ?? '');
  const sampleId = p.source.kind === 'sample' ? p.source.id : '';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('preview.title')}</h1>

      <Card className="no-print flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">
            <span className="font-medium">{t('preview.sample')}</span>
            <select
              className={selectCls}
              value={sampleId}
              onChange={(e) =>
                e.target.value && p.setSource({ kind: 'sample', id: e.target.value })
              }
            >
              {p.source.kind === 'json' ? <option value="">{p.source.name}</option> : null}
              {SAMPLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            {t('preview.openFile')}
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) p.setSource({ kind: 'json', text: await file.text(), name: file.name });
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('preview.paste')}</summary>
          <div className="mt-2 flex flex-col gap-2">
            <label className="sr-only" htmlFor="paste-json">
              {t('preview.paste')}
            </label>
            <textarea
              id="paste-json"
              className="h-40 rounded-md border border-slate-300 p-2 font-mono text-xs"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <button
              type="button"
              className="self-start rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
              onClick={() => p.setSource({ kind: 'json', text: paste, name: 'pasted.json' })}
            >
              {t('preview.load')}
            </button>
          </div>
        </details>

        {p.loaded.jsonError ? (
          <p role="alert" className="text-sm text-red-ink-800">
            {t('preview.invalidJson', { error: p.loaded.jsonError })}
          </p>
        ) : null}
        {p.loaded.schemaIssues.length ? (
          <div role="alert" className="text-sm text-red-ink-800">
            <p className="font-medium">{t('preview.schemaErrors')}</p>
            <ul className="list-disc pl-5">
              {p.loaded.schemaIssues.slice(0, 20).map((s, i) => (
                <li key={i} className="font-mono">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {q ? <DiagnosticsPanel diagnostics={p.loaded.diagnostics} /> : null}
      </Card>

      {q && p.loaded.compiled && p.session ? (
        <PreviewWorkbench p={p} scenarios={scenarios} />
      ) : null}
      <span hidden>{i18n.resolvedLanguage}</span>
    </div>
  );
}

/**
 * Test-mode controls, the interview in the chosen mode, and the side panels (path tracer,
 * scenarios). Shared by the sample preview and the designer.
 */
export function PreviewWorkbench({
  p,
  scenarios,
}: {
  p: ReturnType<typeof usePreview>;
  scenarios: ScenarioStore;
}) {
  const { t } = useTranslation();
  const [contextText, setContextText] = useState(() => JSON.stringify(p.options.context, null, 2));
  const [contextError, setContextError] = useState<string | null>(null);
  // As the field sees it (the interviewer's or respondent's screen), or the bare test runner.
  const [asSeen, setAsSeen] = useState(true);
  const q = p.loaded.questionnaire;
  // Only the questionnaire's modes (Q1); switch to one of them if the current mode is not.
  const modes = q?.modes?.length ? q.modes : MODES;
  const off = !!q && !modes.includes(p.options.mode);
  useEffect(() => {
    if (off) p.update({ mode: modes[0]! });
  }, [off]);
  if (!q || !p.loaded.compiled || !p.session) return null;
  return (
    <>
      <Card className="no-print flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('preview.mode')}</span>
          <select
            className={selectCls}
            value={p.options.mode}
            onChange={(e) => p.update({ mode: e.target.value as Mode })}
            data-testid="mode"
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {m} · {t(`designer.modeNames.${m}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('preview.language')}</span>
          <select
            className={selectCls}
            value={p.options.language}
            onChange={(e) => p.update({ language: e.target.value })}
          >
            {q.languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('preview.today')}</span>
          <input
            type="date"
            className={selectCls}
            value={p.options.today}
            onChange={(e) => e.target.value && p.update({ today: e.target.value })}
          />
        </label>
        {q.quotas.length ? (
          <fieldset className="text-sm">
            <legend className="font-medium">{t('preview.quotasFull')}</legend>
            <div className="flex flex-wrap gap-3 pt-1">
              {q.quotas.map((quota) => (
                <label key={quota.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={p.options.quotasFull.includes(quota.id)}
                    onChange={(e) =>
                      p.update({
                        quotasFull: e.target.checked
                          ? [...p.options.quotasFull, quota.id]
                          : p.options.quotasFull.filter((x) => x !== quota.id),
                      })
                    }
                  />
                  {quota.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <button
          type="button"
          className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
          onClick={p.reset}
        >
          {t('preview.reset')}
        </button>
        <details className="w-full">
          <summary className="cursor-pointer text-sm font-medium">{t('preview.context')}</summary>
          <p className="mt-1 text-xs text-slate-600">{t('preview.contextHelp')}</p>
          <label className="sr-only" htmlFor="context-json">
            {t('preview.context')}
          </label>
          <textarea
            id="context-json"
            className="mt-2 h-32 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
            value={contextText}
            aria-invalid={!!contextError}
            onChange={(e) => {
              setContextText(e.target.value);
              try {
                const ctx = JSON.parse(e.target.value);
                setContextError(null);
                p.update({ context: ctx });
              } catch (err) {
                setContextError((err as Error).message);
              }
            }}
          />
          {contextError ? <p className="text-xs text-red-ink-800">{contextError}</p> : null}
        </details>
      </Card>

      {/* The interview gets the full width (as the field sees it); the tracer sits beside it
          only when there is room for both. */}
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Tabs.Root defaultValue="interview" className="flex min-w-0 flex-col gap-4">
          <Tabs.List
            aria-label={t('preview.title')}
            className="no-print flex flex-wrap gap-1 border-b border-slate-200"
          >
            {(['interview', 'compare', 'answers'] as const).map((tab) => (
              <Tabs.Trigger
                key={tab}
                value={tab}
                className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-ink-700"
              >
                {t(`preview.tabs.${tab}`)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="interview" className="focus:outline-none">
            {p.options.mode === 'PAPI' ? (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  className="no-print self-end rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                  onClick={() => window.print()}
                >
                  {t('preview.printPaper')}
                </button>
                <div className="rounded-lg border border-slate-200 shadow-sm print:border-0 print:shadow-none">
                  <PaperForm compiled={p.loaded.compiled} lang={p.options.language} />
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="no-print flex items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    checked={asSeen}
                    onChange={(e) => setAsSeen(e.target.checked)}
                  />
                  {p.options.mode === 'CAWI'
                    ? t('preview.asSeen.toggleRespondent')
                    : t('preview.asSeen.toggleInterviewer')}
                </label>
                {asSeen ? (
                  <AsSeenFrame
                    session={p.session}
                    mode={p.options.mode}
                    lang={p.options.language}
                    onChange={p.onChange}
                    context={p.options.context as { case?: Record<string, unknown> }}
                  />
                ) : (
                  <Card>
                    <p className="mb-4 text-sm text-slate-500">
                      {pick(q.title, p.options.language)}
                    </p>
                    <InterviewRunner
                      key={`${p.options.mode}`}
                      session={p.session}
                      mode={p.options.mode}
                      lang={p.options.language}
                      onChange={p.onChange}
                    />
                  </Card>
                )}
              </div>
            )}
          </Tabs.Content>
          <Tabs.Content value="compare">
            <ComparePanel session={p.session} compiled={p.loaded.compiled} options={p.options} />
          </Tabs.Content>
          <Tabs.Content value="answers">
            <AnswersPanel session={p.session} />
          </Tabs.Content>
        </Tabs.Root>
        <aside className="no-print flex flex-col gap-6" aria-label={t('preview.tracer')}>
          <PathTracer
            session={p.session}
            onJump={(key) => {
              p.session!.jumpTo(key);
              p.onChange();
            }}
          />
          <ScenariosPanel
            store={scenarios}
            compiled={p.loaded.compiled}
            toScenario={p.toScenario}
          />
        </aside>
      </div>
    </>
  );
}
