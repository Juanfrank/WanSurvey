import * as Tabs from '@radix-ui/react-tabs';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { buildModel, compile, type CompiledQuestionnaire } from '@wansurvey/logic';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { DiagnosticsPanel, ScenariosPanel } from '../preview/panels.js';
import { PreviewWorkbench } from '../preview/PreviewPage.js';
import { usePreview } from '../preview/usePreview.js';
import { ListIcon } from '../routes/icons.js';
import { SideDrawer, useDrawer } from '../routes/SideDrawer.js';
import { Button, Card } from '../routes/ui.js';
import { SubTabBar, TabBar } from '../routes/tabs.js';
import { CawiTab } from '../cawi/CawiTab.js';
import { PaperTab } from '../papi/PaperTab.js';
import { TypeEnvContext } from './context.js';
import { Dialog } from './Dialog.js';
import { EditingLanguageContext, smallBtn } from './fields.js';
import { download, useApiScenarios, useCan, useRetire, useVersions } from './hooks.js';
import { ItemEditor } from './ItemEditor.js';
import { initials, Outline, SETTINGS_ID } from './Outline.js';
import { PipeVariablesContext } from './PipeAssist.js';
import { PublishDialog } from './PublishDialog.js';
import { RoutingMap } from './RoutingMap.js';
import { CommentsPanel, openCounts, useComments } from './CommentsPanel.js';
import { ComparePanel } from './ComparePanel.js';
import { InsertFromLibraryDialog, SaveToLibraryDialog } from './LibraryDialogs.js';
import { useCollab } from './useCollab.js';
import { SETTINGS_PARTS, SettingsEditor, type SettingsPart } from './SettingsEditor.js';
import { flatten, isSection, locate, type Draft } from './tree.js';
import { iconKeyOf, KindIcon } from './kinds.js';
import { useDraft, type DraftApi } from './useDraft.js';
import { useRouting } from './useRouting.js';
import { caseVariables, nodeName, variablesOf, type SampleField } from './vars.js';
import { localiseDiagnostic } from '../i18n-messages.js';
import { dateTime, timeOnly } from '../format.js';

const TOPS = ['design', 'distribution', 'settings'] as const;
type Top = (typeof TOPS)[number];
const DESIGN_SUBS = ['design', 'routing', 'preview', 'scenarios', 'versions'] as const;
type DesignSub = (typeof DESIGN_SUBS)[number];
const has = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  !!v && (list as readonly string[]).includes(v);

/**
 * A questionnaire in tabs on two levels: Design (form, flow, preview, scenarios, versions),
 * Distribution (web survey, paper forms) and Settings (by topic). The place is in the address.
 */
export function DesignerPage() {
  const { projectId, qid } = useParams({ strict: false }) as { projectId: string; qid: string };
  const { t } = useTranslation();
  const d = useDraft(projectId, qid);
  const canEdit = useCan('questionnaires.edit', projectId);
  const canPublish = useCan('questionnaires.publish', projectId);
  const search = useSearch({ strict: false }) as { tab?: string; sub?: string; notice?: string };
  const navigate = useNavigate();
  const top: Top = has(TOPS, search.tab) ? search.tab : 'design';
  const tab: DesignSub = top === 'design' && has(DESIGN_SUBS, search.sub) ? search.sub : 'design';
  const settingsPart: SettingsPart =
    top === 'settings' && has(SETTINGS_PARTS, search.sub) ? search.sub : 'general';
  const go = (t: Top, sub?: string) =>
    void navigate({
      to: '.',
      search: (s: Record<string, unknown>) => ({ ...s, tab: t, sub }),
      replace: true,
    });
  const setTab = (sub: string) => go('design', sub);
  const canWeb = useCan('cawi.waves', projectId);
  const canKey = useCan('dataentry.key', projectId);
  const canReviewForms = useCan('interviews.review', projectId);
  const canCasesAll = useCan('cases.read_all', projectId);
  const canPaper = canKey || canReviewForms || canCasesAll;
  const [selected, setSelected] = useState(SETTINGS_ID);
  const [renameTick, setRenameTick] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [libraryAt, setLibraryAt] = useState<{ after: string | null; inside: boolean } | null>(
    null,
  );
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const outline = useDrawer('ws.outline.pinned');
  // Alt+O, anywhere on the Design tab: the outline (opens the drawer when it is not pinned,
  // closes it when open, and puts focus on the current row).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyO' || tab !== 'design') return;
      if (top !== 'design') return;
      e.preventDefault();
      if (!outline.inline && outline.open) return outline.setOpen(false);
      if (!outline.inline) outline.setOpen(true);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('#designer-outline [role=treeitem][tabindex="0"]')
          ?.focus(),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [outline, tab, top]);
  const canComment = useCan('questionnaires.comment', projectId) || canEdit;
  const comments = useComments(projectId, qid);
  const commentCounts = useMemo(() => openCounts(comments.data), [comments.data]);
  const editors = useCollab(projectId, qid, d, selected === SETTINGS_ID ? null : selected, (m) => {
    setMessage(m);
    setNotice(m);
  });
  const others = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of editors) if (e.itemId) m.set(e.itemId, [...(m.get(e.itemId) ?? []), e.name]);
    return m;
  }, [editors]);

  const draft = d.draft;
  // Questionnaire texts are edited one language at a time; the default language first.
  const [editLang, setEditLang] = useState<string | null>(null);
  const lang =
    editLang && draft?.languages.includes(editLang) ? editLang : (draft?.defaultLanguage ?? 'es');
  // The project's sample fields are offered as case.* in conditions.
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ name: string }>(`/projects/${projectId}`),
  });
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
  const problemsById = useMemo(() => {
    const m = new Map<string, { errors: number; warnings: number }>();
    for (const x of d.diagnostics) {
      if (!x.itemId) continue;
      const p = m.get(x.itemId) ?? { errors: 0, warnings: 0 };
      if (x.severity === 'error') p.errors++;
      else p.warnings++;
      m.set(x.itemId, p);
    }
    return m;
  }, [d.diagnostics]);
  const [highlight, setHighlight] = useState(false);

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
    outline.setOpen(false);
    const first = editorRef.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]), select, textarea, button[role=tab]',
    );
    (first ?? editorRef.current)?.focus();
  };

  return (
    <TypeEnvContext.Provider value={typeVars}>
      <PipeVariablesContext.Provider value={variables}>
        <EditingLanguageContext.Provider value={lang}>
          <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
            {/* As tall as the account pill beside it, so the name row starts below it. */}
            <nav
              aria-label={t('designer.breadcrumb')}
              className="text-sm text-slate-600 min-[900px]:min-h-10"
            >
              <Link to="/projects" className="hover:underline">
                {t('designer.projects')}
              </Link>{' '}
              /{' '}
              <Link to="/projects/$projectId" params={{ projectId }} className="hover:underline">
                {project.data?.name ?? t('designer.project')}
              </Link>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="sr-only">{d.name}</h1>
              <label className="flex min-w-[16rem] flex-1 items-center gap-2">
                <span className="sr-only">{t('designer.name')}</span>
                <input
                  className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-2xl font-semibold hover:border-slate-300 focus:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  value={d.name}
                  readOnly={!canEdit}
                  onChange={(e) => d.rename(e.target.value)}
                />
              </label>
              {draft.languages.length > 1 ? (
                <label className="flex items-center gap-2 text-sm">
                  <span>{t('designer.contentLanguage')}</span>
                  <select
                    className="rounded-md border border-slate-300 bg-white px-2 py-1"
                    value={lang}
                    onChange={(e) => setEditLang(e.target.value)}
                  >
                    {draft.languages.map((l) => (
                      <option key={l} value={l}>
                        {l}
                        {l === draft.defaultLanguage ? ` (${t('designer.settings.default')})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
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
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900">
                {t('designer.readOnly')}
              </p>
            ) : null}
            <p role="status" aria-live="polite" className="sr-only">
              {message}
            </p>
            {editors.length || notice ? (
              <div
                className="flex flex-wrap items-center gap-2 text-sm text-slate-700"
                data-testid="presence"
              >
                {editors.length ? (
                  <>
                    <span>{t('designer.collab.others')}</span>
                    {editors.map((e) => (
                      <span
                        key={e.userId}
                        className="flex items-center gap-1 rounded-full bg-sky-50 py-0.5 pl-0.5 pr-2"
                      >
                        <span
                          aria-hidden
                          className="rounded-full bg-sky-800 px-1.5 text-[10px] font-semibold text-on-fill"
                        >
                          {initials(e.name)}
                        </span>
                        {e.name}
                        {e.itemId ? (
                          <span className="text-xs text-slate-600">
                            {t('designer.collab.on', { id: e.itemId })}
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </>
                ) : null}
                {notice ? <span className="text-xs text-slate-600">{notice}</span> : null}
              </div>
            ) : null}

            <Tabs.Root
              value={top}
              onValueChange={(v) => go(v as Top)}
              className="flex flex-col gap-4"
            >
              <TabBar
                label={t('designer.top.label')}
                items={[
                  { value: 'design', label: t('designer.top.design') },
                  ...(canWeb || canPaper
                    ? [{ value: 'distribution', label: t('designer.top.distribution') }]
                    : []),
                  { value: 'settings', label: t('designer.top.settings') },
                ]}
              />
              <Tabs.Content value="design">
                <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
                  <SubTabBar
                    label={t('designer.designSections')}
                    items={[
                      { value: 'design', label: t('designer.tab.form') },
                      {
                        value: 'routing',
                        label: (
                          <>
                            {t('designer.tab.routing')}
                            {errorCount ? (
                              <span className="ml-1.5 rounded bg-red-100 px-1.5 text-xs text-red-ink-900">
                                {errorCount}
                              </span>
                            ) : null}
                          </>
                        ),
                      },
                      { value: 'preview', label: t('designer.tab.preview') },
                      { value: 'scenarios', label: t('designer.tab.scenarios') },
                      { value: 'versions', label: t('designer.tab.versions') },
                    ]}
                  />

                  <Tabs.Content
                    value="design"
                    className="grid grid-cols-[3rem_minmax(0,1fr)] gap-4 min-[900px]:grid-cols-1"
                  >
                    <SideDrawer
                      id="designer-outline"
                      drawer={outline}
                      side="left"
                      label={t('designer.outline.title')}
                      icon={<ListIcon />}
                    >
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
                        others={others}
                        commentCounts={commentCounts}
                        onInsertFromLibrary={(after, inside) => setLibraryAt({ after, inside })}
                        onSaveToLibrary={(id) => {
                          setSelected(id);
                          setSavingToLibrary(true);
                        }}
                      />
                    </SideDrawer>
                    <div className="flex min-w-0 flex-col gap-4">
                      <section
                        ref={editorRef}
                        tabIndex={-1}
                        aria-label={t('designer.editor')}
                        className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm focus:outline-none"
                      >
                        {others.get(selected)?.length ? (
                          <p
                            className="mb-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-ink-950"
                            data-testid="same-item"
                          >
                            {t('designer.collab.sameItem', {
                              who: others.get(selected)!.join(', '),
                            })}
                          </p>
                        ) : null}
                        <EditorHeader
                          draft={draft}
                          selected={selected}
                          onGo={setSelected}
                          onSave={
                            canEdit &&
                            selected !== SETTINGS_ID &&
                            !draft.sections.some((x) => x.id === selected)
                              ? () => setSavingToLibrary(true)
                              : undefined
                          }
                        />
                        <fieldset disabled={!canEdit} className="min-w-0">
                          {selected === SETTINGS_ID ? (
                            <p className="text-sm text-slate-600">{t('designer.emptyEditor')}</p>
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
                      <CommentsPanel
                        projectId={projectId}
                        qid={qid}
                        itemId={selected === SETTINGS_ID ? null : selected}
                        canWrite={canComment}
                        onGoTo={(id) => (id ? setSelected(id) : go('settings', 'general'))}
                      />
                    </div>
                  </Tabs.Content>

                  <Tabs.Content value="routing" className="flex flex-col gap-3">
                    <LogicCheck
                      diagnostics={d.diagnostics}
                      highlight={highlight}
                      onHighlight={setHighlight}
                      onGoTo={(id) => {
                        setSelected(id);
                        setTab('design');
                        requestAnimationFrame(focusEditor);
                      }}
                    />
                    {routing ? (
                      <RoutingMap
                        draft={draft}
                        routing={routing}
                        lang={lang}
                        problems={highlight ? problemsById : null}
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
              </Tabs.Content>
              <Tabs.Content value="distribution">
                <Distribution
                  projectId={projectId}
                  qid={qid}
                  sub={search.sub}
                  notice={search.notice}
                  web={canWeb && (draft.modes ?? ['CAPI', 'CATI', 'CAWI', 'PAPI']).includes('CAWI')}
                  paper={
                    canPaper && (draft.modes ?? ['CAPI', 'CATI', 'CAWI', 'PAPI']).includes('PAPI')
                  }
                  onSub={(sub) => go('distribution', sub)}
                />
              </Tabs.Content>
              <Tabs.Content value="settings">
                <Tabs.Root
                  value={settingsPart}
                  onValueChange={(v) => go('settings', v)}
                  className="flex flex-col gap-4"
                >
                  <SubTabBar
                    label={t('designer.settingsSections')}
                    items={SETTINGS_PARTS.map((x) => ({
                      value: x,
                      label: x === 'modes' ? t('designer.modes') : t(`designer.settings.${x}`),
                    }))}
                  />
                  <Tabs.Content value={settingsPart}>
                    <Card>
                      <h2 className="sr-only">
                        {settingsPart === 'modes'
                          ? t('designer.modes')
                          : t(`designer.settings.${settingsPart}`)}
                      </h2>
                      <fieldset disabled={!canEdit} className="min-w-0">
                        <SettingsEditor
                          draft={draft}
                          variables={variables}
                          change={d.change}
                          part={settingsPart}
                        />
                      </fieldset>
                    </Card>
                  </Tabs.Content>
                </Tabs.Root>
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
            {libraryAt ? (
              <InsertFromLibraryDialog
                draft={draft}
                afterId={libraryAt.after}
                inside={libraryAt.inside}
                onClose={() => setLibraryAt(null)}
                onInsert={(next, newId, msg) => {
                  d.change(next);
                  setSelected(newId);
                  setLibraryAt(null);
                  setMessage(msg);
                  setNotice(msg);
                }}
              />
            ) : null}
            {savingToLibrary ? (
              <SaveToLibraryDialog
                draft={draft}
                id={selected}
                onClose={() => setSavingToLibrary(false)}
                onSaved={(msg) => {
                  setSavingToLibrary(false);
                  setMessage(msg);
                  setNotice(msg);
                }}
              />
            ) : null}
            {d.conflict ? (
              <Dialog title={t('designer.conflict.title')} onClose={() => undefined}>
                <p className="mb-4 text-sm">
                  {t('designer.conflict.text', {
                    who: d.conflict.updatedBy ?? t('designer.conflict.someone'),
                    when: timeOnly(d.conflict.updatedAt),
                  })}
                </p>
                {d.conflict.items?.length ? (
                  <p className="mb-4 text-sm" data-testid="conflict-items">
                    {t('designer.collab.conflictItems', { list: d.conflict.items.join(', ') })}
                  </p>
                ) : null}
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
        </EditingLanguageContext.Provider>
      </PipeVariablesContext.Provider>
    </TypeEnvContext.Provider>
  );
}

/**
 * The editor's title row: what is selected (icon, kind and name), with arrows at each end to
 * step to the previous or next row of the outline, and "Save to library" on the right.
 */
function EditorHeader({
  draft,
  selected,
  onGo,
  onSave,
}: {
  draft: Draft;
  selected: string;
  onGo(id: string): void;
  onSave?: () => void;
}) {
  const { t } = useTranslation();
  const order = flatten(draft).map((r) => r.node.id);
  const i = order.indexOf(selected);
  const prev = i > 0 ? order[i - 1] : undefined;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : undefined;
  const node = selected === SETTINGS_ID ? null : (locate(draft, selected)?.node ?? null);
  const kind = !node
    ? t('designer.settings.title')
    : isSection(node)
      ? t('designer.kind.section')
      : node.kind === 'question'
        ? t(`designer.type.${node.type}`)
        : t(`designer.kind.${node.kind}`);
  const nameOf = (id: string | undefined) => {
    if (!id) return '';
    if (id === SETTINGS_ID) return t('designer.settings.title');
    const n = locate(draft, id)?.node;
    return n ? nodeName(n) : id;
  };
  const arrow =
    'flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:opacity-30';
  return (
    <div className="-mx-1 mb-4 flex items-center gap-2 border-b border-slate-200 pb-3">
      <button
        type="button"
        className={arrow}
        disabled={!prev}
        aria-label={t('designer.prevItem', { name: nameOf(prev) })}
        title={t('designer.prevItem', { name: nameOf(prev) })}
        onClick={() => prev && onGo(prev)}
        data-testid="editor-prev"
      >
        <span aria-hidden>‹</span>
      </button>
      <h2 className="flex min-w-0 flex-1 items-center gap-2 text-lg font-semibold">
        {node ? <KindIcon k={iconKeyOf(node)} className="size-5 text-indigo-ink-700" /> : null}
        <span className="truncate">{kind}</span>
        {node ? (
          <span className="truncate font-mono text-base font-normal text-slate-500">
            {nodeName(node)}
          </span>
        ) : null}
      </h2>
      {onSave ? (
        <button type="button" className={smallBtn} onClick={onSave}>
          {t('designer.library.save')}
        </button>
      ) : null}
      <button
        type="button"
        className={arrow}
        disabled={!next}
        aria-label={t('designer.nextItem', { name: nameOf(next) })}
        title={t('designer.nextItem', { name: nameOf(next) })}
        onClick={() => next && onGo(next)}
        data-testid="editor-next"
      >
        <span aria-hidden>›</span>
      </button>
    </div>
  );
}

/**
 * "Check the logic": runs the questionnaire's checks and answers in a floating bubble, either
 * that all is well or with the problems, a link to each item and a switch that marks the items
 * with problems on the routing map.
 */
function LogicCheck({
  diagnostics,
  highlight,
  onHighlight,
  onGoTo,
}: {
  diagnostics: DraftApi['diagnostics'];
  highlight: boolean;
  onHighlight(on: boolean): void;
  onGoTo(id: string): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const errors = diagnostics.filter((x) => x.severity === 'error').length;
  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="relative flex flex-wrap items-center gap-3">
      <Button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {t('designer.routing.check')}
      </Button>
      {highlight ? (
        <button type="button" className={smallBtn} onClick={() => onHighlight(false)}>
          {t('designer.routing.unhighlight')}
        </button>
      ) : null}
      {open ? (
        <div
          ref={ref}
          tabIndex={-1}
          role="dialog"
          aria-label={t('designer.routing.checkTitle')}
          className={`absolute left-0 top-full z-30 mt-2 w-[min(32rem,calc(100vw-2rem))] rounded-xl border bg-white p-4 shadow-xl focus:outline-none ${
            diagnostics.length
              ? errors
                ? 'border-red-200'
                : 'border-amber-200'
              : 'border-emerald-200'
          }`}
          data-testid="logic-check"
        >
          <span
            aria-hidden
            className="absolute -top-1.5 left-6 size-3 rotate-45 border-l border-t border-inherit bg-white"
          />
          {diagnostics.length === 0 ? (
            <p className="flex items-center gap-2 font-medium text-emerald-ink-800">
              <span aria-hidden>✓</span> {t('designer.routing.allGood')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <DiagnosticsPanel diagnostics={diagnostics} />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="text-sm font-medium text-indigo-ink-700 underline"
                  onClick={() => {
                    onHighlight(true);
                    setOpen(false);
                  }}
                >
                  {t('designer.routing.highlight')}
                </button>
              </div>
              <ul className="flex max-h-48 flex-col gap-1 overflow-auto text-sm">
                {diagnostics
                  .filter((x) => x.itemId)
                  .map((x, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="text-left text-indigo-ink-700 underline"
                        onClick={() => onGoTo(x.itemId!)}
                      >
                        {t('designer.goTo', { id: x.itemId })}
                      </button>{' '}
                      <span
                        className={
                          x.severity === 'error' ? 'text-red-ink-800' : 'text-amber-ink-800'
                        }
                      >
                        {localiseDiagnostic(t, x)}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button type="button" className={smallBtn} onClick={() => setOpen(false)}>
              {t('designer.routing.close')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SaveStatus({ status }: { status: DraftApi['status'] }) {
  const { t } = useTranslation();
  const style =
    status === 'error' || status === 'conflict'
      ? 'text-red-ink-800'
      : status === 'saved'
        ? 'text-emerald-ink-800'
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
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900">
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
                {dateTime(v.publishedAt)}
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

/** Where the questionnaire goes out: its web survey and its paper forms. */
function Distribution({
  projectId,
  qid,
  sub,
  notice,
  web,
  paper,
  onSub,
}: {
  projectId: string;
  qid: string;
  sub?: string;
  notice?: string;
  web: boolean;
  paper: boolean;
  onSub(sub: string): void;
}) {
  const { t } = useTranslation();
  const subs = [...(web ? ['web'] : []), ...(paper ? ['paper'] : [])];
  const current = sub && subs.includes(sub) ? sub : subs[0];
  if (!current) return <Card>{t('designer.distribution.none')}</Card>;
  return (
    <Tabs.Root value={current} onValueChange={onSub} className="flex flex-col gap-4">
      <SubTabBar
        label={t('designer.distribution.label')}
        items={subs.map((x) => ({ value: x, label: t(`designer.distribution.${x}`) }))}
      />
      <Tabs.Content value="web">
        <CawiTab projectId={projectId} questionnaireId={qid} />
      </Tabs.Content>
      <Tabs.Content value="paper">
        <PaperTab projectId={projectId} questionnaireId={qid} notice={notice} />
      </Tabs.Content>
    </Tabs.Root>
  );
}
