import * as Tabs from '@radix-ui/react-tabs';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { buildModel, compile, type CompiledQuestionnaire } from '@wansurvey/logic';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { DiagnosticsPanel, ScenariosPanel } from '../preview/panels.js';
import { PreviewWorkbench } from '../preview/PreviewPage.js';
import { usePreview } from '../preview/usePreview.js';
import { Button, Card } from '../routes/ui.js';
import { TypeEnvContext } from './context.js';
import { Dialog } from './Dialog.js';
import { smallBtn } from './fields.js';
import { download, useApiScenarios, useCan, useRetire, useVersions } from './hooks.js';
import { ItemEditor } from './ItemEditor.js';
import { Outline, SETTINGS_ID } from './Outline.js';
import { PublishDialog } from './PublishDialog.js';
import { RoutingMap } from './RoutingMap.js';
import { ComparePanel } from './ComparePanel.js';
import { SettingsEditor } from './SettingsEditor.js';
import type { Draft } from './tree.js';
import { useDraft, type DraftApi } from './useDraft.js';
import { useRouting } from './useRouting.js';
import { caseVariables, variablesOf, type SampleField } from './vars.js';
import { localiseDiagnostic } from '../i18n-messages.js';

const tabCls =
  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-700';

/** The questionnaire designer: outline + editor, logic check, preview, scenarios and versions. */
export function DesignerPage() {
  const { projectId, qid } = useParams({ strict: false }) as { projectId: string; qid: string };
  const { t } = useTranslation();
  const d = useDraft(projectId, qid);
  const canEdit = useCan('questionnaires.edit', projectId);
  const canPublish = useCan('questionnaires.publish', projectId);
  const [tab, setTab] = useState('design');
  const [selected, setSelected] = useState(SETTINGS_ID);
  const [renameTick, setRenameTick] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState('');
  const editorRef = useRef<HTMLElement>(null);

  const draft = d.draft;
  const lang = draft?.defaultLanguage ?? 'en';
  // The project's sample fields are offered as case.* in conditions.
  const sampleFields = useQuery({
    queryKey: ['sample-fields', projectId],
    queryFn: () => api<SampleField[]>(`/projects/${projectId}/sample-fields`),
    retry: false,
  });
  const variables = useMemo(
    () => (draft ? [...variablesOf(draft, lang), ...caseVariables(sampleFields.data ?? [])] : []),
    [draft, lang, sampleFields.data],
  );
  const routing = useRouting(d);
  const typeVars = useMemo(
    () => (d.questionnaire ? buildModel(d.questionnaire).vars : null),
    [d.questionnaire],
  );
  const errorsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of d.diagnostics)
      if (x.severity === 'error' && x.itemId) m.set(x.itemId, (m.get(x.itemId) ?? 0) + 1);
    return m;
  }, [d.diagnostics]);
  const errorCount = d.diagnostics.filter((x) => x.severity === 'error').length;

  // Start on the first section once loaded.
  useEffect(() => {
    if (draft && selected === SETTINGS_ID && draft.sections?.[0]) setSelected(draft.sections[0].id);
    // Only on first load.
  }, [d.doc?.id]);

  if (d.error) return <p role="alert">{t('designer.loadFailed')}</p>;
  if (!draft || !d.doc) return <p aria-busy="true">{t('designer.loading')}</p>;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !canEdit) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      d.undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      d.redo();
    } else if (k === 's') {
      e.preventDefault();
      void d.save();
    }
  };

  const focusEditor = () => {
    const first = editorRef.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]), select, textarea, button[role=tab]',
    );
    (first ?? editorRef.current)?.focus();
  };

  return (
    <TypeEnvContext.Provider value={typeVars}>
      <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
        <nav aria-label={t('designer.breadcrumb')} className="text-sm text-slate-600">
          <Link to="/projects" className="hover:underline">
            {t('designer.projects')}
          </Link>{' '}
          /{' '}
          <Link to="/projects/$projectId" params={{ projectId }} className="hover:underline">
            {t('designer.project')}
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="sr-only">{d.name}</h1>
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="sr-only">{t('designer.name')}</span>
            <input
              className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-2xl font-semibold hover:border-slate-300 focus:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              value={d.name}
              readOnly={!canEdit}
              onChange={(e) => d.rename(e.target.value)}
            />
          </label>
          <SaveStatus status={d.status} />
          {canEdit ? (
            <>
              <button type="button" className={smallBtn} disabled={!d.canUndo} onClick={d.undo}>
                {t('designer.undo')}
              </button>
              <button type="button" className={smallBtn} disabled={!d.canRedo} onClick={d.redo}>
                {t('designer.redo')}
              </button>
            </>
          ) : null}
          {canPublish ? (
            <Button
              type="button"
              onClick={() => setPublishing(true)}
              disabled={d.status === 'conflict'}
            >
              {t('designer.publish.open')}
            </Button>
          ) : null}
        </div>
        {!canEdit ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {t('designer.readOnly')}
          </p>
        ) : null}
        <p role="status" aria-live="polite" className="sr-only">
          {message}
        </p>

        <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
          <Tabs.List
            aria-label={t('designer.tabs')}
            className="flex flex-wrap gap-1 border-b border-slate-200"
          >
            <Tabs.Trigger value="design" className={tabCls}>
              {t('designer.tab.design')}
            </Tabs.Trigger>
            <Tabs.Trigger value="routing" className={tabCls}>
              {t('designer.tab.routing')}
            </Tabs.Trigger>
            <Tabs.Trigger value="check" className={tabCls}>
              {t('designer.tab.check')}
              {errorCount ? (
                <span className="ml-1.5 rounded bg-red-100 px-1.5 text-xs text-red-900">
                  {errorCount}
                </span>
              ) : null}
            </Tabs.Trigger>
            <Tabs.Trigger value="preview" className={tabCls}>
              {t('designer.tab.preview')}
            </Tabs.Trigger>
            <Tabs.Trigger value="scenarios" className={tabCls}>
              {t('designer.tab.scenarios')}
            </Tabs.Trigger>
            <Tabs.Trigger value="versions" className={tabCls}>
              {t('designer.tab.versions')}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="design" className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
            <Outline
              draft={draft}
              selected={selected}
              onSelect={setSelected}
              change={d.change}
              errorsById={errorsById}
              routing={routing}
              lang={lang}
              readOnly={!canEdit}
              onRename={() => setRenameTick((n) => n + 1)}
              onEnter={focusEditor}
              announce={setMessage}
            />
            <section
              ref={editorRef}
              tabIndex={-1}
              aria-label={t('designer.editor')}
              className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm focus:outline-none"
            >
              <fieldset disabled={!canEdit} className="min-w-0">
                {selected === SETTINGS_ID ? (
                  <SettingsEditor draft={draft} variables={variables} change={d.change} />
                ) : (
                  <ItemEditor
                    key={selected}
                    draft={draft}
                    id={selected}
                    lang={lang}
                    variables={variables}
                    change={d.change}
                    focusNameSignal={renameTick}
                    select={setSelected}
                  />
                )}
              </fieldset>
            </section>
          </Tabs.Content>

          <Tabs.Content value="routing">
            {routing ? (
              <RoutingMap
                draft={draft}
                routing={routing}
                lang={lang}
                onOpen={(id) => {
                  setSelected(id);
                  setTab('design');
                  requestAnimationFrame(focusEditor);
                }}
              />
            ) : (
              <Card>{t('designer.routing.unavailable')}</Card>
            )}
          </Tabs.Content>

          <Tabs.Content value="check">
            <Card>
              <DiagnosticsPanel diagnostics={d.diagnostics} />
              <ul className="mt-4 flex flex-col gap-1 text-sm">
                {d.diagnostics
                  .filter((x) => x.itemId)
                  .map((x, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="text-left text-indigo-700 underline"
                        onClick={() => {
                          setSelected(x.itemId!);
                          setTab('design');
                          requestAnimationFrame(focusEditor);
                        }}
                      >
                        {t('designer.goTo', { id: x.itemId })}
                      </button>{' '}
                      <span className={x.severity === 'error' ? 'text-red-800' : 'text-amber-800'}>
                        {localiseDiagnostic(t, x)}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          </Tabs.Content>

          <Tabs.Content value="preview">
            <DraftPreview d={d} projectId={projectId} qid={qid} />
          </Tabs.Content>

          <Tabs.Content value="scenarios">
            <ScenariosTab d={d} projectId={projectId} qid={qid} />
          </Tabs.Content>

          <Tabs.Content value="versions">
            <VersionsPanel
              projectId={projectId}
              qid={qid}
              canPublish={canPublish}
              draft={d.questionnaire}
            />
          </Tabs.Content>
        </Tabs.Root>

        {publishing ? (
          <PublishDialog
            projectId={projectId}
            qid={qid}
            draft={draft}
            flush={d.flush}
            onClose={() => setPublishing(false)}
            onPublished={(v) => {
              setPublishing(false);
              setMessage(t('designer.publish.done', { version: v }));
              setTab('versions');
            }}
          />
        ) : null}
        {d.conflict ? (
          <Dialog title={t('designer.conflict.title')} onClose={() => undefined}>
            <p className="mb-4 text-sm">
              {t('designer.conflict.text', {
                who: d.conflict.updatedBy ?? t('designer.conflict.someone'),
                when: new Date(d.conflict.updatedAt).toLocaleTimeString(),
              })}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" type="button" onClick={() => void d.reloadTheirs()}>
                {t('designer.conflict.reload')}
              </Button>
              <Button type="button" onClick={() => void d.overwriteMine()}>
                {t('designer.conflict.overwrite')}
              </Button>
            </div>
          </Dialog>
        ) : null}
      </div>
    </TypeEnvContext.Provider>
  );
}

function SaveStatus({ status }: { status: DraftApi['status'] }) {
  const { t } = useTranslation();
  const style =
    status === 'error' || status === 'conflict'
      ? 'text-red-800'
      : status === 'saved'
        ? 'text-emerald-800'
        : 'text-slate-600';
  return (
    <span className={`text-sm ${style}`} data-testid="save-status" data-status={status}>
      {t(`designer.status.${status}`)}
    </span>
  );
}

function compiledOf(q: DraftApi['questionnaire']): CompiledQuestionnaire | null {
  if (!q) return null;
  try {
    return compile(q);
  } catch {
    return null;
  }
}

/** The slice 3 test mode on the current draft; it restarts only when asked, not on every edit. */
function DraftPreview({ d, projectId, qid }: { d: DraftApi; projectId: string; qid: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<Draft>(d.draft!);
  const p = usePreview({ kind: 'draft', questionnaire: snapshot, name: d.name });
  const scenarios = useApiScenarios(projectId, qid);
  const changed = snapshot !== d.draft;
  return (
    <div className="flex flex-col gap-4">
      {changed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('designer.preview.changed')}
          <button
            type="button"
            className={smallBtn}
            onClick={() => {
              setSnapshot(d.draft!);
              p.setSource({ kind: 'draft', questionnaire: d.draft, name: d.name });
            }}
          >
            {t('designer.preview.reload')}
          </button>
        </div>
      ) : null}
      {!p.loaded.compiled ? (
        <Card>
          <p className="mb-2 text-sm">{t('designer.preview.fixFirst')}</p>
          <DiagnosticsPanel diagnostics={p.loaded.diagnostics} />
        </Card>
      ) : (
        <PreviewWorkbench p={p} scenarios={scenarios} />
      )}
    </div>
  );
}

function ScenariosTab({ d, projectId, qid }: { d: DraftApi; projectId: string; qid: string }) {
  const { t } = useTranslation();
  const scenarios = useApiScenarios(projectId, qid);
  const compiled = useMemo(() => compiledOf(d.questionnaire), [d.questionnaire]);
  return (
    <Card>
      {compiled ? (
        <ScenariosPanel store={scenarios} compiled={compiled} help={t('designer.scenariosHelp')} />
      ) : (
        <p className="text-sm">{t('designer.preview.fixFirst')}</p>
      )}
    </Card>
  );
}

function VersionsPanel({
  projectId,
  qid,
  canPublish,
  draft,
}: {
  projectId: string;
  qid: string;
  canPublish: boolean;
  draft: DraftApi['questionnaire'];
}) {
  const { t } = useTranslation();
  const versions = useVersions(projectId, qid);
  const retire = useRetire(projectId, qid);
  const [viewing, setViewing] = useState<number | null>(null);
  const full = useQuery({
    queryKey: ['version', qid, viewing],
    queryFn: () =>
      api<{ definition: unknown }>(
        `/projects/${projectId}/questionnaires/${qid}/versions/${viewing}`,
      ),
    enabled: viewing !== null,
  });
  useEffect(() => {
    if (viewing !== null && full.data) {
      download(`questionnaire-v${viewing}.json`, full.data.definition);
      setViewing(null);
    }
  }, [full.data, viewing]);

  if (!versions.data?.length) return <Card>{t('designer.versions.none')}</Card>;
  return (
    <Card>
      <table className="w-full text-sm" data-testid="versions">
        <caption className="mb-2 text-left font-semibold">{t('designer.versions.title')}</caption>
        <thead>
          <tr className="text-left text-xs text-slate-600">
            <th scope="col" className="py-1">
              {t('designer.versions.version')}
            </th>
            <th scope="col">{t('designer.versions.status')}</th>
            <th scope="col">{t('designer.versions.publishedAt')}</th>
            <th scope="col">{t('designer.versions.mapping')}</th>
            <th scope="col">
              <span className="sr-only">{t('designer.opt.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {versions.data.map((v) => (
            <tr key={v.version} data-version={v.version}>
              <td className="py-2 font-mono">v{v.version}</td>
              <td>{t(`designer.versions.${v.status}`)}</td>
              <td>
                {new Date(v.publishedAt).toLocaleString()}
                {v.publishedBy ? ` · ${v.publishedBy}` : ''}
              </td>
              <td>{v.hasMapping ? t('designer.versions.yes') : '—'}</td>
              <td className="whitespace-nowrap text-right">
                <button type="button" className={smallBtn} onClick={() => setViewing(v.version)}>
                  {t('designer.versions.download')}
                </button>{' '}
                {canPublish && v.status === 'published' ? (
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => {
                      if (
                        window.confirm(t('designer.versions.confirmRetire', { version: v.version }))
                      )
                        retire.mutate(v.version);
                    }}
                  >
                    {t('designer.versions.retire')}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6 border-t border-slate-200 pt-4">
        <ComparePanel projectId={projectId} qid={qid} versions={versions.data} draft={draft} />
      </div>
    </Card>
  );
}
