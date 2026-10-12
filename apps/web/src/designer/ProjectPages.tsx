import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { SAMPLES } from '@wansurvey/fixtures';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, Field } from '../routes/ui.js';
import { inputCls } from './fields.js';
import { useCan } from './hooks.js';

export interface Project {
  id: string;
  name: string;
  code: string;
  status: string;
  languages: string[];
  modesEnabled: string[];
}

interface QuestionnaireRow {
  id: string;
  name: string;
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
      <h1 className="text-2xl font-semibold">{t('designer.projects')}</h1>
      <Card>
        {projects.data?.length ? (
          <ul className="divide-y divide-slate-100" data-testid="projects">
            {projects.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: p.id }}
                  className="font-medium text-indigo-700 hover:underline"
                >
                  {p.name}
                </Link>
                <span className="font-mono text-sm text-slate-600">
                  {p.code} · {p.status}
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

export function ProjectPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canEdit = useCan('questionnaires.edit', projectId);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const list = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () => api<QuestionnaireRow[]>(`/projects/${projectId}/questionnaires`),
  });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('blank');
  const [sample, setSample] = useState(SAMPLES[0]!.id);
  const [json, setJson] = useState<{ name: string; definition: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/projects/${projectId}/questionnaires`, {
        method: 'POST',
        body: {
          name: name.trim(),
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
    onError: (e) =>
      setError(e instanceof ApiError ? (e.body.message ?? e.message) : (e as Error).message),
  });

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label={t('designer.breadcrumb')} className="text-sm text-slate-600">
        <Link to="/projects" className="hover:underline">
          {t('designer.projects')}
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold">{project.data?.name ?? '…'}</h1>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('designer.questionnaires')}</h2>
        {list.data?.length ? (
          <table className="w-full text-sm" data-testid="questionnaires">
            <thead>
              <tr className="text-left text-xs text-slate-600">
                <th scope="col" className="py-1">
                  {t('designer.name')}
                </th>
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
                      className="font-medium text-indigo-700 hover:underline"
                    >
                      {q.name}
                    </Link>
                  </td>
                  <td>
                    {q.latestVersion
                      ? `v${q.latestVersion.version} · ${t(`designer.versions.${q.latestVersion.status}`)}`
                      : t('designer.unpublished')}
                  </td>
                  <td>{new Date(q.updatedAt).toLocaleString()}</td>
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
              create.mutate();
            }}
          >
            <Field
              id="new-q-name"
              label={t('designer.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
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
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">{t('preview.openFile')}</span>
                <input
                  type="file"
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
              </label>
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
