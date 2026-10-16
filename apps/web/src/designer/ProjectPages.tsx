import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { SAMPLES } from '@wansurvey/fixtures';
import { MODES, type Mode, type ProjectSettings } from '@wansurvey/schema';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, Field, FileInput } from '../routes/ui.js';
import { AssignmentsTab } from '../cases/AssignmentsTab.js';
import { CasesTab } from '../cases/CasesTab.js';
import { SamplingTab } from '../cases/SamplingTab.js';
import {
  FeedbackFields,
  FeedbackLinks,
  FeedbackResults,
  satisfied,
  useFeedbackPoints,
  type FeedbackDraft,
  type FeedbackPoint,
} from '../feedback/FeedbackParts.js';
import { FeedbackDesigner } from '../feedback/FeedbackDesigner.js';
import { SettingsTab } from '../cases/SettingsTab.js';
import { CallsTab } from '../cati/CallsTab.js';
import { CawiTab } from '../cawi/CawiTab.js';
import { PaperTab } from '../papi/PaperTab.js';
import { ReviewTab } from '../review/ReviewTab.js';
import { DashboardTab } from '../analysis/DashboardTab.js';
import { ExportsTab } from '../analysis/ExportsTab.js';
import { MetricsTab } from '../analysis/MetricsTab.js';
import { ResultsTab } from '../analysis/ResultsTab.js';
import { inputCls } from './fields.js';
import { below, Menu, type MenuEntry } from './Menu.js';
import { useCan } from './hooks.js';
import { dateTime } from '../format.js';

export interface Project {
  id: string;
  name: string;
  code: string;
  status: string;
  languages: string[];
  modesEnabled: string[];
  settings: ProjectSettings;
}

interface QuestionnaireRow {
  id: string;
  name: string;
  /** Modes it is fielded in (Q1). */
  modes: Mode[];
  draftRevision: number;
  updatedAt: string;
  latestVersion: { version: number; status: string; publishedAt: string } | null;
  publishedVersions: number;
}

export function ProjectsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<Project[]>('/projects'),
    enabled: !!me.data,
  });
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('designer.projects')}</h1>
      <Card>
        {projects.data?.length ? (
          <ul className="divide-y divide-slate-100" data-testid="projects">
            {projects.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: p.id }}
                  className="font-medium text-indigo-ink-700 hover:underline"
                >
                  {p.name}
                </Link>
                <span className="font-mono text-sm text-slate-600">
                  {p.code} · {t(`app.projectStatus.${p.status}`, { defaultValue: p.status })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-600">{projects.isLoading ? '…' : t('home.noProjects')}</p>
        )}
      </Card>
    </div>
  );
}

type SourceKind = 'blank' | 'sample' | 'json';

type QPanel =
  | { kind: 'web' | 'paper'; name: string }
  | {
      kind: 'feedbackDesign' | 'feedbackLinks' | 'feedbackResults';
      name: string;
      point: FeedbackPoint;
    }
  | null;

/** What a new item of the questionnaire list is: a questionnaire, or quick feedback (F1). */
type NewFormat = 'questionnaire' | 'feedback';

function QuestionnairesSection({
  projectId,
  project: projectRow,
  canWeb,
  canPaper,
  notice,
  panel,
  onPanel,
}: {
  projectId: string;
  project: Project | undefined;
  canWeb: boolean;
  canPaper: boolean;
  notice?: string;
  panel: QPanel;
  onPanel(p: QPanel): void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canEdit = useCan('questionnaires.edit', projectId);
  const [status, setStatus] = useState('');
  const [menuFor, setMenuFor] = useState<{
    q: QuestionnaireRow;
    at: { x: number; y: number };
  } | null>(null);
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<{ name: string }>(`/projects/${projectId}/questionnaires/${id}`, {
        method: 'PATCH',
        body: { name },
      }),
    onSuccess: async (r) => {
      setStatus(t('designer.qActions.renamed', { name: r.name }));
      await qc.invalidateQueries({ queryKey: ['questionnaires', projectId] });
    },
    onError: (e) => setStatus(localiseError(t, e)),
  });
  const remove = useMutation({
    mutationFn: (q: QuestionnaireRow) =>
      api(`/projects/${projectId}/questionnaires/${q.id}`, { method: 'DELETE' }),
    onSuccess: async (_r, q) => {
      setStatus(t('designer.qActions.deleted', { name: q.name }));
      await qc.invalidateQueries({ queryKey: ['questionnaires', projectId] });
    },
    onError: (e) =>
      setStatus(
        e instanceof ApiError && e.code === 'IN_USE'
          ? t('designer.qActions.inUse')
          : localiseError(t, e),
      ),
  });
  const feedback = useFeedbackPoints(projectId, canWeb);
  const [fbMenu, setFbMenu] = useState<{
    p: FeedbackPoint;
    at: { x: number; y: number };
  } | null>(null);
  const fbPatch = useMutation({
    mutationFn: ({ p, body }: { p: FeedbackPoint; body: { name?: string; active?: boolean } }) =>
      api<FeedbackPoint>(`/projects/${projectId}/feedback/${p.id}`, { method: 'PATCH', body }),
    onSuccess: async (r, { body }) => {
      setStatus(
        body.name
          ? t('designer.qActions.renamed', { name: r.name })
          : r.active
            ? t('feedback.switchedOn', { name: r.name })
            : t('feedback.switchedOff', { name: r.name }),
      );
      await qc.invalidateQueries({ queryKey: ['feedback', projectId] });
    },
    onError: (e) => setStatus(localiseError(t, e)),
  });
  const fbRemove = useMutation({
    mutationFn: (p: FeedbackPoint) =>
      api(`/projects/${projectId}/feedback/${p.id}`, { method: 'DELETE' }),
    onSuccess: async (_r, p) => {
      setStatus(t('designer.qActions.deleted', { name: p.name }));
      await qc.invalidateQueries({ queryKey: ['feedback', projectId] });
    },
    onError: (e) =>
      setStatus(
        e instanceof ApiError && e.code === 'IN_USE' ? t('feedback.inUse') : localiseError(t, e),
      ),
  });
  const feedbackActions = (p: FeedbackPoint): MenuEntry[] => [
    {
      type: 'item',
      id: 'design',
      label: t('feedback.editQuestions'),
      onSelect: () => onPanel({ kind: 'feedbackDesign', name: p.name, point: p }),
    },
    {
      type: 'item',
      id: 'links',
      label: t('feedback.links'),
      onSelect: () => onPanel({ kind: 'feedbackLinks', name: p.name, point: p }),
    },
    {
      type: 'item',
      id: 'print',
      label: t('feedback.print'),
      onSelect: () =>
        void navigate({
          to: '/projects/$projectId/feedback/$pointId/print',
          params: { projectId, pointId: p.id },
        }),
    },
    {
      type: 'item',
      id: 'results',
      label: t('feedback.results'),
      onSelect: () => onPanel({ kind: 'feedbackResults', name: p.name, point: p }),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'rename',
      label: t('designer.qActions.rename'),
      onSelect: () => {
        const name = window.prompt(t('designer.qActions.renamePrompt', { name: p.name }), p.name);
        if (name && name.trim() && name.trim() !== p.name)
          fbPatch.mutate({ p, body: { name: name.trim() } });
      },
    },
    {
      type: 'item',
      id: 'toggle',
      label: p.active ? t('feedback.switchOff') : t('feedback.switchOn'),
      onSelect: () => fbPatch.mutate({ p, body: { active: !p.active } }),
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'delete',
      label: t('designer.qActions.delete'),
      onSelect: () => {
        if (window.confirm(t('designer.qActions.confirmDelete', { name: p.name })))
          fbRemove.mutate(p);
      },
    },
  ];
  const pct = (v: number | null) =>
    v === null
      ? '–'
      : new Intl.NumberFormat(i18n.language, {
          style: 'percent',
          maximumFractionDigits: 0,
        }).format(v);
  const actionsFor = (q: QuestionnaireRow): MenuEntry[] => [
    {
      type: 'item',
      id: 'open',
      label: t('designer.qActions.open'),
      onSelect: () =>
        void navigate({
          to: '/projects/$projectId/questionnaires/$qid',
          params: { projectId, qid: q.id },
        }),
    },
    ...(canEdit
      ? [
          {
            type: 'item' as const,
            id: 'rename',
            label: t('designer.qActions.rename'),
            onSelect: () => {
              const name = window.prompt(
                t('designer.qActions.renamePrompt', { name: q.name }),
                q.name,
              );
              if (name && name.trim() && name.trim() !== q.name)
                rename.mutate({ id: q.id, name: name.trim() });
            },
          },
        ]
      : []),
    ...(canWeb || canPaper ? [{ type: 'separator' as const }] : []),
    ...(canWeb
      ? [
          {
            type: 'item' as const,
            id: 'web',
            label: t('designer.qActions.web'),
            disabled: !q.modes.includes('CAWI'),
            onSelect: () => onPanel({ kind: 'web', name: q.name }),
          },
        ]
      : []),
    ...(canPaper
      ? [
          {
            type: 'item' as const,
            id: 'paper',
            label: t('designer.qActions.paper'),
            disabled: !q.modes.includes('PAPI'),
            onSelect: () => onPanel({ kind: 'paper', name: q.name }),
          },
        ]
      : []),
    ...(canEdit
      ? [
          { type: 'separator' as const },
          {
            type: 'item' as const,
            id: 'delete',
            label: t('designer.qActions.delete'),
            onSelect: () => {
              if (window.confirm(t('designer.qActions.confirmDelete', { name: q.name })))
                remove.mutate(q);
            },
          },
        ]
      : []),
  ];
  const list = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () => api<QuestionnaireRow[]>(`/projects/${projectId}/questionnaires`),
  });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('blank');
  const [sample, setSample] = useState(SAMPLES[0]!.id);
  const [json, setJson] = useState<{ name: string; definition: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The modes the questionnaire is fielded in, chosen now (Q1): the project's, all ticked.
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const offered: readonly Mode[] = project.data?.modesEnabled.length
    ? MODES.filter((m) => project.data!.modesEnabled.includes(m))
    : MODES;
  const [modes, setModes] = useState<Mode[] | null>(null);
  const chosen = modes ?? [...offered];

  const [format, setFormat] = useState<NewFormat>('questionnaire');
  const [draft, setDraft] = useState<FeedbackDraft>({
    question: '',
    faces: 3,
    askComment: true,
  });
  const createFeedback = useMutation({
    mutationFn: () =>
      api<FeedbackPoint>(`/projects/${projectId}/feedback`, {
        method: 'POST',
        body: {
          name: name.trim(),
          question: {
            [projectRow?.languages[0] ?? 'es']:
              draft.question.trim() || t('feedback.questionDefault'),
          },
          faces: draft.faces,
          askComment: draft.askComment,
        },
      }),
    onSuccess: async (p) => {
      setName('');
      setDraft({ question: '', faces: 3, askComment: true });
      await qc.invalidateQueries({ queryKey: ['feedback', projectId] });
      onPanel({ kind: 'feedbackDesign', name: p.name, point: p });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/projects/${projectId}/questionnaires`, {
        method: 'POST',
        body: {
          name: name.trim(),
          modes: chosen,
          source:
            kind === 'sample'
              ? { kind, id: sample }
              : kind === 'json'
                ? { kind, definition: json?.definition }
                : { kind },
        },
      }),
    onSuccess: async (q) => {
      await qc.invalidateQueries({ queryKey: ['questionnaires', projectId] });
      await navigate({
        to: '/projects/$projectId/questionnaires/$qid',
        params: { projectId, qid: q.id },
      });
    },
    onError: (e) => setError(localiseError(t, e)),
  });

  if (panel)
    return (
      <div className="flex flex-col gap-4" data-testid={`q-panel-${panel.kind}`}>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
            onClick={() => onPanel(null)}
          >
            ← {t('designer.qActions.back')}
          </button>
          <h2 className="text-lg font-semibold">
            {panel.name
              ? t('designer.qActions.panelTitle', {
                  what:
                    panel.kind === 'feedbackDesign'
                      ? t('feedback.editQuestions')
                      : panel.kind === 'feedbackLinks'
                        ? t('feedback.links')
                        : panel.kind === 'feedbackResults'
                          ? t('feedback.results')
                          : t(`designer.qActions.${panel.kind}`),
                  name: panel.name,
                })
              : panel.kind === 'web' || panel.kind === 'paper'
                ? t(`designer.qActions.${panel.kind}`)
                : null}
          </h2>
        </div>
        {panel.kind === 'web' ? (
          projectRow ? (
            <CawiTab project={projectRow} />
          ) : null
        ) : panel.kind === 'paper' ? (
          <PaperTab projectId={projectId} notice={notice} />
        ) : panel.kind === 'feedbackDesign' ? (
          <Card>
            <FeedbackDesigner
              projectId={projectId}
              point={panel.point}
              lang={projectRow?.languages[0] ?? 'es'}
              onSaved={(p) => onPanel({ kind: 'feedbackDesign', name: p.name, point: p })}
            />
          </Card>
        ) : panel.kind === 'feedbackLinks' ? (
          <Card>
            <FeedbackLinks point={panel.point} />
          </Card>
        ) : panel.kind === 'feedbackResults' ? (
          <Card>
            <FeedbackResults projectId={projectId} point={panel.point} />
          </Card>
        ) : null}
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('designer.questionnaires')}</h2>
        <p role="status" aria-live="polite" className="mb-2 text-sm text-slate-700 empty:hidden">
          {status}
        </p>
        {list.data?.length || feedback.data?.length ? (
          <table className="w-full text-sm" data-testid="questionnaires">
            <thead>
              <tr className="text-left text-xs text-slate-600">
                <th scope="col" className="py-1">
                  {t('designer.name')}
                </th>
                <th scope="col">{t('designer.modes')}</th>
                <th scope="col">{t('designer.latestVersion')}</th>
                <th scope="col">{t('designer.statusCol')}</th>
                <th scope="col">{t('designer.lastEdited')}</th>
                <th scope="col">
                  <span className="sr-only">{t('designer.qActions.label')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(list.data ?? []).map((q) => (
                <tr key={q.id}>
                  <td className="py-2">
                    <Link
                      to="/projects/$projectId/questionnaires/$qid"
                      params={{ projectId, qid: q.id }}
                      className="font-medium text-indigo-ink-700 hover:underline"
                    >
                      {q.name}
                    </Link>
                  </td>
                  <td>
                    <ModeChips modes={q.modes} />
                  </td>
                  <td className="font-mono">
                    {q.latestVersion ? `v${q.latestVersion.version}` : '—'}
                  </td>
                  <td>
                    {q.latestVersion
                      ? t(`designer.versions.${q.latestVersion.status}`)
                      : t('designer.unpublished')}
                  </td>
                  <td>{dateTime(q.updatedAt)}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50"
                      aria-haspopup="menu"
                      aria-expanded={menuFor?.q.id === q.id}
                      aria-label={t('designer.qActions.menu', { name: q.name })}
                      onClick={(e) => setMenuFor({ q, at: below(e.currentTarget) })}
                      data-testid="q-actions"
                    >
                      {t('designer.qActions.label')} ▾
                    </button>
                  </td>
                </tr>
              ))}
              {(feedback.data ?? []).map((p) => {
                const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
                return (
                  <tr key={p.id} data-feedback={p.name}>
                    <td className="py-2">
                      <button
                        type="button"
                        className="text-left font-medium text-indigo-ink-700 hover:underline"
                        onClick={() => onPanel({ kind: 'feedbackDesign', name: p.name, point: p })}
                      >
                        {p.name}
                      </button>
                    </td>
                    <td>
                      <ModeChips modes={['LIKERT']} />
                    </td>
                    <td className="font-mono">v{p.version}</td>
                    <td>
                      {p.active ? t('feedback.active') : t('feedback.inactive')} ·{' '}
                      {t('feedback.answers', { count: total })} ·{' '}
                      {t('feedback.satisfied', { pct: pct(satisfied(p)) })}
                    </td>
                    <td>{dateTime(p.updatedAt ?? p.createdAt ?? '')}</td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50"
                        aria-haspopup="menu"
                        aria-expanded={fbMenu?.p.id === p.id}
                        aria-label={t('designer.qActions.menu', { name: p.name })}
                        onClick={(e) => setFbMenu({ p, at: below(e.currentTarget) })}
                      >
                        {t('designer.qActions.label')} ▾
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-slate-600">{list.isLoading ? '…' : t('designer.noQuestionnaires')}</p>
        )}
        {menuFor ? (
          <Menu
            label={t('designer.qActions.menu', { name: menuFor.q.name })}
            entries={actionsFor(menuFor.q)}
            at={menuFor.at}
            onClose={() => setMenuFor(null)}
          />
        ) : null}
        {fbMenu ? (
          <Menu
            label={t('designer.qActions.menu', { name: fbMenu.p.name })}
            entries={feedbackActions(fbMenu.p)}
            at={fbMenu.at}
            onClose={() => setFbMenu(null)}
          />
        ) : null}
      </Card>
      {canEdit ? (
        <Card>
          <h2 className="mb-3 text-lg font-semibold">{t('designer.create.title')}</h2>
          <form
            className="flex max-w-xl flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (!name.trim()) return setError(t('designer.create.nameRequired'));
              if (format === 'feedback') return createFeedback.mutate();
              if (kind === 'json' && !json) return setError(t('designer.create.fileRequired'));
              if (!chosen.length) return setError(t('designer.create.modesRequired'));
              create.mutate();
            }}
          >
            <Field
              id="new-q-name"
              label={format === 'feedback' ? t('feedback.name') : t('designer.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {canWeb ? (
              <fieldset className="flex flex-col gap-2 text-sm" data-testid="new-format">
                <legend className="mb-1 font-medium text-slate-700">{t('feedback.format')}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(['questionnaire', 'feedback'] as const).map((f) => (
                    <label
                      key={f}
                      className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 bg-white p-3 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
                    >
                      <input
                        type="radio"
                        name="new-format"
                        className="mt-0.5"
                        checked={format === f}
                        onChange={() => setFormat(f)}
                      />
                      <span>
                        <span className="flex items-center gap-2 font-medium">
                          {t(`feedback.formats.${f}`)}
                        </span>
                        <span className="block text-xs text-slate-600">
                          {t(`feedback.formatHints.${f}`)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {format === 'feedback' ? (
              <FeedbackFields value={draft} onChange={setDraft} />
            ) : (
              <>
                <fieldset className="flex flex-col gap-2 text-sm" data-testid="new-q-modes">
                  <legend className="mb-1 font-medium text-slate-700">
                    {t('designer.create.modes')}
                  </legend>
                  <p className="text-slate-600">{t('designer.create.modesHelp')}</p>
                  <div className="flex flex-wrap gap-2">
                    {offered.map((m) => (
                      <label
                        key={m}
                        className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
                      >
                        <input
                          type="checkbox"
                          checked={chosen.includes(m)}
                          onChange={(e) =>
                            setModes(
                              e.target.checked
                                ? MODES.filter((x) => x === m || chosen.includes(x))
                                : chosen.filter((x) => x !== m),
                            )
                          }
                        />
                        <span className="font-semibold">{m}</span>
                        <span className="text-slate-600">{t(`designer.modeNames.${m}`)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="flex flex-col gap-2 text-sm">
                  <legend className="mb-1 font-medium text-slate-700">
                    {t('designer.create.start')}
                  </legend>
                  {(['blank', 'sample', 'json'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="source"
                        checked={kind === k}
                        onChange={() => setKind(k)}
                      />
                      {t(`designer.create.${k}`)}
                    </label>
                  ))}
                </fieldset>
                {kind === 'sample' ? (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-slate-700">{t('preview.sample')}</span>
                    <select
                      className={inputCls}
                      value={sample}
                      onChange={(e) => setSample(e.target.value)}
                    >
                      {SAMPLES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {kind === 'json' ? (
                  <FileInput
                    label={t('preview.openFile')}
                    labelClassName="font-medium text-slate-700"
                    accept="application/json,.json"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        setJson({ name: file.name, definition: JSON.parse(await file.text()) });
                        setError(null);
                      } catch (err) {
                        setJson(null);
                        setError(t('preview.invalidJson', { error: (err as Error).message }));
                      }
                    }}
                  />
                ) : null}
              </>
            )}
            <ErrorText>{error}</ErrorText>
            <div>
              <Button type="submit" disabled={create.isPending || createFeedback.isPending}>
                {format === 'feedback' ? t('feedback.add') : t('designer.create.submit')}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

/** The modes of a questionnaire as small labels, with their names for screen readers. */
export function ModeChips({ modes }: { modes: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1" data-testid="mode-chips">
      {modes.map((m) => (
        <span
          key={m}
          title={t(`designer.modeNames.${m}`)}
          className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-ink-800"
        >
          {m}
          <span className="sr-only"> ({t(`designer.modeNames.${m}`)})</span>
        </span>
      ))}
    </span>
  );
}

const tabCls =
  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-navy data-[state=active]:border-indigo-600 data-[state=active]:font-semibold data-[state=active]:text-indigo-ink-600';

type ProjectTab =
  'cases' | 'questionnaires' | 'calls' | 'paper' | 'review' | 'results' | 'exports' | 'settings';
type CasesSub = 'list' | 'sampling' | 'assignments';
type ResultsSub = 'topline' | 'dashboard' | 'metrics';

/** Old `?tab=` values still land in the right place: web and paper forms, dashboard, import… */
const FROM_SEARCH: Record<
  string,
  { tab: ProjectTab; cases?: CasesSub; results?: ResultsSub; panel?: 'web' | 'paper' }
> = {
  cases: { tab: 'cases' },
  import: { tab: 'cases', cases: 'sampling' },
  sampling: { tab: 'cases', cases: 'sampling' },
  assignments: { tab: 'cases', cases: 'assignments' },
  questionnaires: { tab: 'questionnaires' },
  web: { tab: 'questionnaires', panel: 'web' },
  paper: { tab: 'questionnaires', panel: 'paper' },
  calls: { tab: 'calls' },
  review: { tab: 'review' },
  results: { tab: 'results', results: 'topline' },
  dashboard: { tab: 'results', results: 'dashboard' },
  metrics: { tab: 'results', results: 'metrics' },
  exports: { tab: 'exports' },
  settings: { tab: 'settings' },
};

const subTabCls =
  'rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 data-[state=active]:bg-indigo-50 data-[state=active]:font-semibold data-[state=active]:text-indigo-ink-700';

/**
 * A project, in the order work happens: cases (list, sampling selector, assignments), the
 * questionnaires (with their web survey and paper forms as actions), calls, review, results
 * (summary, dashboard, metrics), exports and settings; each as allowed by role.
 */
export function ProjectPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const search = useSearch({ strict: false }) as { tab?: string; notice?: string };
  const { t } = useTranslation();
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const canQuestionnaires = useCan('questionnaires.read', projectId);
  const canCasesAll = useCan('cases.read_all', projectId);
  const canCasesOwn = useCan('cases.read_assigned', projectId);
  const canImport = useCan('cases.import', projectId);
  const canAssign = useCan('cases.assign', projectId);
  const canSettings = useCan('projects.update', projectId);
  const canWeb =
    useCan('cawi.waves', projectId) &&
    (!project.data?.modesEnabled.length || project.data.modesEnabled.includes('CAWI'));
  const canKeyForms = useCan('dataentry.key', projectId);
  const canReview = useCan('interviews.review', projectId);
  const canApprove = useCan('interviews.approve', projectId);
  const canDashboard = useCan('dashboards.read', projectId);
  const canMetricsTeam = useCan('metrics.team', projectId);
  const canMetricsOwn = useCan('metrics.own', projectId);
  const canMetrics = canMetricsTeam || canMetricsOwn;
  const canExport = useCan('exports.run', projectId);
  const canPaperRole = canKeyForms || canReview || canCasesAll;
  const canPaper =
    canPaperRole &&
    (!project.data?.modesEnabled.length || project.data.modesEnabled.includes('PAPI'));
  const canDevice =
    useCan('interviews.conduct', projectId) &&
    (!project.data?.modesEnabled.length || project.data.modesEnabled.includes('CAPI'));
  const canCall =
    useCan('interviews.conduct', projectId) &&
    (!project.data?.modesEnabled.length || project.data.modesEnabled.includes('CATI'));

  const casesSubs: CasesSub[] = [
    ...(canCasesAll || canCasesOwn ? (['list'] as const) : []),
    ...(canImport ? (['sampling'] as const) : []),
    ...(canAssign ? (['assignments'] as const) : []),
  ];
  const resultsSubs: ResultsSub[] = [
    ...(canDashboard ? (['topline', 'dashboard'] as const) : []),
    ...(canMetrics ? (['metrics'] as const) : []),
  ];
  const tabs: ProjectTab[] = [
    // The questionnaires are defined first; then the sample says who answers them.
    ...(canQuestionnaires ? (['questionnaires'] as const) : []),
    ...(casesSubs.length ? (['cases'] as const) : []),
    ...(canCall ? (['calls'] as const) : []),
    // Data-entry clerks who do not see the questionnaires keep paper forms as a tab.
    ...(canPaper && !canQuestionnaires ? (['paper'] as const) : []),
    ...(canReview || canApprove ? (['review'] as const) : []),
    ...(resultsSubs.length ? (['results'] as const) : []),
    ...(canExport ? (['exports'] as const) : []),
    ...(canSettings ? (['settings'] as const) : []),
  ];
  const initial = search.tab ? FROM_SEARCH[search.tab] : undefined;
  const [tab, setTab] = useState<ProjectTab | null>(
    initial?.tab === 'questionnaires' && initial.panel === 'paper' && !canQuestionnaires
      ? 'paper'
      : (initial?.tab ?? null),
  );
  const [casesSub, setCasesSub] = useState<CasesSub>(initial?.cases ?? 'list');
  const [resultsSub, setResultsSub] = useState<ResultsSub>(initial?.results ?? 'topline');
  const [panel, setPanel] = useState<QPanel>(
    initial?.panel ? { kind: initial.panel, name: '' } : null,
  );
  const current = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
  const cases = casesSubs.includes(casesSub) ? casesSub : casesSubs[0]!;
  const results = resultsSubs.includes(resultsSub) ? resultsSub : resultsSubs[0]!;
  // The place in the page is kept in the address (?tab=…), so Back and reload return to it.
  const navigate = useNavigate();
  const place =
    current === 'cases'
      ? cases === 'list'
        ? 'cases'
        : cases
      : current === 'results'
        ? results === 'topline'
          ? 'results'
          : results
        : current === 'questionnaires' && panel
          ? panel.kind
          : current;
  useEffect(() => {
    if (!place || place === search.tab) return;
    void navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { tab: place },
      replace: true,
    });
  }, [place]);

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label={t('designer.breadcrumb')} className="text-sm text-slate-600">
        <Link to="/projects" className="hover:underline">
          {t('designer.projects')}
        </Link>
      </nav>
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-bold">{project.data?.name ?? '…'}</h1>
        {canDevice ? (
          <Link
            to="/projects/$projectId/device"
            params={{ projectId }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            {t('device.link')}
          </Link>
        ) : null}
      </div>
      {current ? (
        <Tabs.Root
          value={current}
          onValueChange={(v) => {
            setTab(v as ProjectTab);
            if (v !== 'questionnaires') setPanel(null);
          }}
          className="flex flex-col gap-4"
        >
          <Tabs.List
            aria-label={t('cases.tabs.label')}
            className="flex flex-wrap gap-1 border-b border-slate-200"
          >
            {tabs.map((x) => (
              <Tabs.Trigger
                key={x}
                value={x}
                className={tabCls}
                // The Cases tab always opens on the case list; the questionnaires on their list.
                onClick={() => {
                  if (x === 'cases') setCasesSub('list');
                  if (x === 'questionnaires') setPanel(null);
                }}
              >
                {x === 'cases' && !canCasesAll ? t('cases.list.mine') : t(`cases.tabs.${x}`)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="cases">
            {casesSubs.length > 1 ? (
              <Tabs.Root
                value={cases}
                onValueChange={(v) => setCasesSub(v as CasesSub)}
                className="flex flex-col gap-4"
              >
                <Tabs.List
                  aria-label={t('cases.tabs.casesSections')}
                  className="flex flex-wrap gap-1"
                >
                  {casesSubs.map((x) => (
                    <Tabs.Trigger key={x} value={x} className={subTabCls}>
                      {t(`cases.tabs.${x}`)}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
                <Tabs.Content value="list">
                  <CasesTab projectId={projectId} />
                </Tabs.Content>
                <Tabs.Content value="sampling">
                  <SamplingTab projectId={projectId} />
                </Tabs.Content>
                <Tabs.Content value="assignments">
                  <AssignmentsTab projectId={projectId} />
                </Tabs.Content>
              </Tabs.Root>
            ) : cases === 'list' ? (
              <CasesTab projectId={projectId} />
            ) : cases === 'sampling' ? (
              <SamplingTab projectId={projectId} />
            ) : (
              <AssignmentsTab projectId={projectId} />
            )}
          </Tabs.Content>
          <Tabs.Content value="questionnaires">
            <QuestionnairesSection
              projectId={projectId}
              project={project.data}
              canWeb={canWeb}
              canPaper={canPaper}
              notice={search.notice}
              panel={panel}
              onPanel={setPanel}
            />
          </Tabs.Content>
          <Tabs.Content value="calls">
            <CallsTab projectId={projectId} notice={search.notice} />
          </Tabs.Content>
          <Tabs.Content value="paper">
            <PaperTab projectId={projectId} notice={search.notice} />
          </Tabs.Content>
          <Tabs.Content value="review">
            <ReviewTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="results">
            <Tabs.Root
              value={results}
              onValueChange={(v) => setResultsSub(v as ResultsSub)}
              className="flex flex-col gap-4"
            >
              {resultsSubs.length > 1 ? (
                <Tabs.List
                  aria-label={t('cases.tabs.resultsSections')}
                  className="flex flex-wrap gap-1"
                >
                  {resultsSubs.map((x) => (
                    <Tabs.Trigger key={x} value={x} className={subTabCls}>
                      {t(`cases.tabs.${x}`)}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              ) : null}
              <Tabs.Content value="topline">
                <ResultsTab projectId={projectId} />
              </Tabs.Content>
              <Tabs.Content value="dashboard">
                {current === 'results' && results === 'dashboard' ? (
                  <DashboardTab projectId={projectId} />
                ) : null}
              </Tabs.Content>
              <Tabs.Content value="metrics">
                <MetricsTab projectId={projectId} />
              </Tabs.Content>
            </Tabs.Root>
          </Tabs.Content>
          <Tabs.Content value="exports">
            <ExportsTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="settings">
            {project.data ? <SettingsTab project={project.data} /> : null}
          </Tabs.Content>
        </Tabs.Root>
      ) : null}
    </div>
  );
}
