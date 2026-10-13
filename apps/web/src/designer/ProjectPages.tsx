import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { SAMPLES } from '@wansurvey/fixtures';
import { MODES, type Mode, type ProjectSettings } from '@wansurvey/schema';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, Field, FileInput } from '../routes/ui.js';
import { AssignmentsTab } from '../cases/AssignmentsTab.js';
import { CasesTab } from '../cases/CasesTab.js';
import { ImportTab } from '../cases/ImportTab.js';
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

function QuestionnairesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canEdit = useCan('questionnaires.edit', projectId);
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

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('designer.questionnaires')}</h2>
        {list.data?.length ? (
          <table className="w-full text-sm" data-testid="questionnaires">
            <thead>
              <tr className="text-left text-xs text-slate-600">
                <th scope="col" className="py-1">
                  {t('designer.name')}
                </th>
                <th scope="col">{t('designer.modes')}</th>
                <th scope="col">{t('designer.latestVersion')}</th>
                <th scope="col">{t('designer.lastEdited')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.map((q) => (
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
                  <td>
                    {q.latestVersion
                      ? `v${q.latestVersion.version} · ${t(`designer.versions.${q.latestVersion.status}`)}`
                      : t('designer.unpublished')}
                  </td>
                  <td>{dateTime(q.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-slate-600">{list.isLoading ? '…' : t('designer.noQuestionnaires')}</p>
        )}
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
              if (kind === 'json' && !json) return setError(t('designer.create.fileRequired'));
              if (!chosen.length) return setError(t('designer.create.modesRequired'));
              create.mutate();
            }}
          >
            <Field
              id="new-q-name"
              label={t('designer.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
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
            <ErrorText>{error}</ErrorText>
            <div>
              <Button type="submit" disabled={create.isPending}>
                {t('designer.create.submit')}
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
  | 'questionnaires'
  | 'cases'
  | 'calls'
  | 'web'
  | 'paper'
  | 'review'
  | 'dashboard'
  | 'metrics'
  | 'results'
  | 'exports'
  | 'import'
  | 'assignments'
  | 'settings';

/** A project: its questionnaires, cases, sample import and assignments, as allowed by role. */
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
  const tabs: ProjectTab[] = [
    ...(canQuestionnaires ? (['questionnaires'] as const) : []),
    ...(canCasesAll || canCasesOwn ? (['cases'] as const) : []),
    ...(canCall ? (['calls'] as const) : []),
    ...(canWeb ? (['web'] as const) : []),
    ...(canPaper ? (['paper'] as const) : []),
    ...(canReview || canApprove ? (['review'] as const) : []),
    ...(canDashboard ? (['dashboard'] as const) : []),
    ...(canMetrics ? (['metrics'] as const) : []),
    ...(canDashboard ? (['results'] as const) : []),
    ...(canExport ? (['exports'] as const) : []),
    ...(canImport ? (['import'] as const) : []),
    ...(canAssign ? (['assignments'] as const) : []),
    ...(canSettings ? (['settings'] as const) : []),
  ];
  const [tab, setTab] = useState<ProjectTab | null>((search.tab as ProjectTab) ?? null);
  const current = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);

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
          onValueChange={(v) => setTab(v as ProjectTab)}
          className="flex flex-col gap-4"
        >
          <Tabs.List
            aria-label={t('cases.tabs.label')}
            className="flex flex-wrap gap-1 border-b border-slate-200"
          >
            {tabs.map((x) => (
              <Tabs.Trigger key={x} value={x} className={tabCls}>
                {x === 'cases' && !canCasesAll ? t('cases.list.mine') : t(`cases.tabs.${x}`)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="questionnaires">
            <QuestionnairesSection projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="cases">
            <CasesTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="calls">
            <CallsTab projectId={projectId} notice={search.notice} />
          </Tabs.Content>
          <Tabs.Content value="web">
            {project.data ? <CawiTab project={project.data} /> : null}
          </Tabs.Content>
          <Tabs.Content value="paper">
            <PaperTab projectId={projectId} notice={search.notice} />
          </Tabs.Content>
          <Tabs.Content value="review">
            <ReviewTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="dashboard">
            {current === 'dashboard' ? <DashboardTab projectId={projectId} /> : null}
          </Tabs.Content>
          <Tabs.Content value="metrics">
            <MetricsTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="results">
            <ResultsTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="exports">
            <ExportsTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="import">
            <ImportTab projectId={projectId} onDone={() => setTab('cases')} />
          </Tabs.Content>
          <Tabs.Content value="assignments">
            <AssignmentsTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="settings">
            {project.data ? <SettingsTab project={project.data} /> : null}
          </Tabs.Content>
        </Tabs.Root>
      ) : null}
    </div>
  );
}
