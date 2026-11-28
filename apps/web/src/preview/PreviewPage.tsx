import * as Tabs from '@radix-ui/react-tabs';
import { SAMPLES } from '@wansurvey/fixtures';
import { InterviewRunner, PaperForm, pick, type PaperContext } from '@wansurvey/renderer';
import { MODES, type Mode } from '@wansurvey/schema';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Card, PageHeader } from '../routes/ui.js';
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
import { useMedia } from '../routes/SideDrawer.js';

const selectCls = 'max-w-full rounded-md border border-slate-300 bg-white px-2 py-1.5';

/** The designer's test mode: run any questionnaire in every mode and see why the path goes where it goes. */
export function PreviewPage() {
  const { t, i18n } = useTranslation();
  const p = usePreview();
  const [paste, setPaste] = useState('');
  // Open or folded, kept across a change of source (the line moves in and out of the set-up).
  const [sourceOpen, setSourceOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const q = p.loaded.questionnaire;
  const scenarios = useLocalScenarios(q?.id ?? '');
  const sampleId = p.source.kind === 'sample' ? p.source.id : '';
  const sourceTitle =
    p.source.kind === 'sample'
      ? (SAMPLES.find((x) => x.id === sampleId)?.title ?? '')
      : p.source.kind === 'json'
        ? p.source.name
        : '';
  const errors = p.loaded.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = p.loaded.diagnostics.length - errors;

  const runs = !!(q && p.loaded.compiled && p.session);

  // The questionnaire (sample, file or pasted JSON) and its checks, folded into one line with
  // the counts, so the interview starts near the top.
  const source = (
    <details
      open={sourceOpen}
      onToggle={(e) => setSourceOpen(e.currentTarget.open)}
      className="no-print group rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-card"
      data-testid="preview-source"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-sm [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-xs text-slate-500 group-open:rotate-90">
          ▶
        </span>
        <span className="font-medium">{t('preview.source')}:</span>
        <span className="min-w-0 truncate">{sourceTitle}</span>
        {q ? (
          <>
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            {errors ? (
              <span className="font-medium text-red-ink-800">
                {t('preview.errorsCount', { count: errors })}
              </span>
            ) : null}
            {warnings ? (
              <span className="text-amber-ink-900">
                {t('preview.warningsCount', { count: warnings })}
              </span>
            ) : null}
            {!errors && !warnings ? (
              <span className="text-emerald-ink-800">{t('preview.noIssues')}</span>
            ) : null}
          </>
        ) : null}
      </summary>
      <div className="mt-3 flex flex-col gap-4 pb-2">
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
        <details open={pasteOpen} onToggle={(e) => setPasteOpen(e.currentTarget.open)}>
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

        {q ? <DiagnosticsPanel diagnostics={p.loaded.diagnostics} /> : null}
      </div>
    </details>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Opened from Home and run on the samples (or a file): no project above it, so the way
      back is Home. */}
      <PageHeader
        parents={[
          <Link key="home" to="/" className="hover:underline">
            {t('app.home')}
          </Link>,
        ]}
        title={t('preview.title')}
      />
      {/* While the interview runs, the source goes with the test's set-up (folded on a phone). */}
      {runs ? null : source}
      {p.loaded.jsonError ? (
        <p role="alert" className="no-print text-sm text-red-ink-800">
          {t('preview.invalidJson', { error: p.loaded.jsonError })}
        </p>
      ) : null}
      {p.loaded.schemaIssues.length ? (
        <div role="alert" className="no-print text-sm text-red-ink-800">
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

      {runs ? <PreviewWorkbench p={p} scenarios={scenarios} setup={source} /> : null}
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
  setup,
}: {
  p: ReturnType<typeof usePreview>;
  scenarios: ScenarioStore;
  /** Shown before the controls, and folded with them on a narrow screen (the source line). */
  setup?: ReactNode;
}) {
  const { t } = useTranslation();
  // Below 768 px the set-up (source, mode, language, date, quotas, JSON, restart) folds behind
  // one "Set up the test" line, so the question is on the first screen.
  const narrow = useMedia('(max-width: 767px)');
  const [setupOpen, setSetupOpen] = useState(false);
  const [contextText, setContextText] = useState(() => JSON.stringify(p.options.context, null, 2));
  const [contextError, setContextError] = useState<string | null>(null);
  // As the field sees it (the interviewer's or respondent's screen), or the bare test runner.
  const [asSeen, setAsSeen] = useState(true);
  const [view, setView] = useState('interview');
  const q = p.loaded.questionnaire;
  // Only the questionnaire's modes (Q1); switch to one of them if the current mode is not.
  const modes = q?.modes?.length ? q.modes : MODES;
  const off = !!q && !modes.includes(p.options.mode);
  useEffect(() => {
    if (off) p.update({ mode: modes[0]! });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- switches mode only when it turns invalid
  }, [off]);
  if (!q || !p.loaded.compiled || !p.session) return null;
  const errors = p.loaded.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = p.loaded.diagnostics.length - errors;
  const controls = (
    <>
      {setup}
      {/* Mode, language, date and full quotas in one slim bar above the interview. */}
      <div
        className="no-print flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm shadow-card"
        data-testid="preview-controls"
      >
        <label className="flex items-center gap-2">
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
        <label className="flex items-center gap-2">
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
        <label className="flex items-center gap-2">
          <span className="font-medium">{t('preview.today')}</span>
          <input
            type="date"
            className={selectCls}
            value={p.options.today}
            onChange={(e) => e.target.value && p.update({ today: e.target.value })}
          />
        </label>
        {q.quotas.length ? (
          <div
            role="group"
            aria-label={t('preview.quotasFull')}
            title={t('preview.quotasFull')}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span aria-hidden="true" className="font-medium">
              {t('preview.quotasShort')}
            </span>
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
        ) : null}
        <details className="group open:basis-full">
          <summary className="cursor-pointer font-medium">{t('preview.context')}</summary>
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
        <button
          type="button"
          className="ml-auto rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
          onClick={p.reset}
        >
          {t('preview.reset')}
        </button>
      </div>
    </>
  );
  return (
    <>
      {narrow ? (
        <>
          <button
            type="button"
            aria-expanded={setupOpen}
            aria-controls="preview-setup"
            onClick={() => setSetupOpen(!setupOpen)}
            className="no-print flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-left text-sm shadow-card hover:bg-slate-50"
            data-testid="preview-setup-toggle"
          >
            <span className="flex-none font-medium">{t('preview.setup')}</span>
            <span
              aria-hidden="true"
              className={`flex-none text-xs text-slate-500 ${setupOpen ? 'rotate-90' : ''}`}
            >
              ▸
            </span>
            {/* What is set now, so it can stay folded: mode, language and the checks. */}
            <span className="min-w-0 truncate text-slate-600">
              {p.options.mode} · {p.options.language}
              {errors ? (
                <span className="text-red-ink-800">
                  {' · '}
                  {t('preview.errorsCount', { count: errors })}
                </span>
              ) : warnings ? (
                <span className="text-amber-ink-900">
                  {' · '}
                  {t('preview.warningsCount', { count: warnings })}
                </span>
              ) : null}
              {/* Test data that is not valid JSON is not used: said here too while folded. */}
              {contextError ? (
                <span className="text-red-ink-800">
                  {' · '}
                  {t('preview.contextInvalid')}
                </span>
              ) : null}
            </span>
          </button>
          <div id="preview-setup" hidden={!setupOpen} className="flex flex-col gap-6">
            {controls}
          </div>
        </>
      ) : (
        controls
      )}

      {/* The interview gets the full width (as the field sees it); the tracer sits beside it
          only when there is room for both. */}
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Tabs.Root value={view} onValueChange={setView} className="flex min-w-0 flex-col gap-4">
          <div className="no-print flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-slate-200">
            <Tabs.List aria-label={t('preview.title')} className="flex flex-wrap gap-1">
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
            {view !== 'interview' ? null : p.options.mode === 'PAPI' ? (
              <button
                type="button"
                className="mb-1.5 ml-auto rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                onClick={() => window.print()}
              >
                {t('preview.printPaper')}
              </button>
            ) : (
              <label className="mb-2 ml-auto flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={asSeen}
                  onChange={(e) => setAsSeen(e.target.checked)}
                />
                {p.options.mode === 'CAWI'
                  ? t('preview.asSeen.toggleRespondent')
                  : t('preview.asSeen.toggleInterviewer')}
              </label>
            )}
          </div>
          <Tabs.Content value="interview" className="focus:outline-none">
            {p.options.mode === 'PAPI' ? (
              <div className="flex flex-col gap-3">
                <div className="rounded-lg border border-slate-200 shadow-sm print:border-0 print:shadow-none">
                  <PaperForm
                    compiled={p.loaded.compiled}
                    lang={p.options.language}
                    context={p.options.context as PaperContext}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
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
