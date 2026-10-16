import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeCondition, tryParse } from '@wansurvey/logic';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuestionnaireScope, useScoped } from './scope.js';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { ConditionBuilder } from '../designer/ConditionBuilder.js';
import { controlCls, NumberField, smallBtn, TextField } from '../designer/fields.js';
import type { Project } from '../designer/ProjectPages.js';
import { caseVariables } from '../designer/vars.js';
import { Button, Card, ErrorText } from '../routes/ui.js';
import { STATUSES, useAssignees, useSampleFields } from './hooks.js';

interface Rule {
  id: string;
  userId: string;
  userName: string;
  name: string | null;
  filter: string | null;
  quota: number | null;
  active: boolean;
  matching: number;
  unassigned: number;
  assignedToUser: number;
}

/** Workload per person, assignment rules, and applying them. */
export function AssignmentsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const people = useAssignees(projectId, true);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const fields = useSampleFields(projectId);
  const variables = useMemo(() => caseVariables(fields.data ?? []), [fields.data]);
  const questionnaire = useQuestionnaireScope();
  const scoped = useScoped();
  const rules = useQuery({
    queryKey: ['rules', projectId, questionnaire],
    queryFn: () => api<Rule[]>(scoped(`/projects/${projectId}/assignments`)),
  });
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [filter, setFilter] = useState<string | undefined>();
  const [quota, setQuota] = useState<number | undefined>();
  const [preview, setPreview] = useState<{ matching: number; unassigned: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['rules', projectId] });
    await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
    await qc.invalidateQueries({ queryKey: ['cases', projectId] });
  };
  const fail = (e: unknown) => setError(localiseError(t, e));

  useEffect(() => {
    setPreview(null);
    if (!filter) return;
    const id = setTimeout(() => {
      api<{ matching: number; unassigned: number }>(`/projects/${projectId}/assignments/preview`, {
        method: 'POST',
        body: { filter, ...(questionnaire ? { questionnaireId: questionnaire } : {}) },
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(id);
  }, [filter, projectId, questionnaire]);

  const create = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/assignments`, {
        method: 'POST',
        body: {
          userId,
          filter,
          ...(name ? { name } : {}),
          quota: quota ?? null,
          ...(questionnaire ? { questionnaireId: questionnaire } : {}),
        },
      }),
    onSuccess: async () => {
      setName('');
      setFilter(undefined);
      setQuota(undefined);
      setError(null);
      await refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api(`/projects/${projectId}/assignments/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/assignments/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: fail,
  });
  const apply = useMutation({
    mutationFn: () =>
      api<{ assigned: number }>(`/projects/${projectId}/assignments/apply`, {
        method: 'POST',
        body: questionnaire ? { questionnaireId: questionnaire } : {},
      }),
    onSuccess: async (r) => {
      setMessage(t('cases.rules.applied', { count: r.assigned }));
      await refresh();
    },
    onError: fail,
  });

  const describe = (src: string | null) => {
    if (!src) return '';
    const p = tryParse(src);
    return p.ok
      ? describeCondition(p.node, {
          ref: (n) => n,
          label: () => null,
          t: (k, v) => t(k, { ...v, ns: 'renderer' }),
        })
      : src;
  };

  return (
    <div className="flex flex-col gap-6">
      {project.data?.settings.assignmentMode === 'pool' ? (
        <p
          className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-ink-950"
          data-testid="pool-mode"
        >
          {t('cases.rules.poolMode')}
        </p>
      ) : null}
      <Card>
        <h2 className="mb-1 text-lg font-semibold">{t('cases.rules.workload')}</h2>
        {people.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="workload">
              <thead className="text-left text-xs text-slate-600">
                <tr>
                  <th scope="col" className="py-1">
                    {t('cases.rules.person')}
                  </th>
                  {STATUSES.filter((s) => s !== 'fresh').map((s) => (
                    <th key={s} scope="col">
                      {t(`cases.status.${s}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {people.data.map((p) => (
                  <tr key={p.userId} data-person={p.email}>
                    <th scope="row" className="py-1.5 text-left font-medium">
                      {p.name}
                    </th>
                    {STATUSES.filter((s) => s !== 'fresh').map((s) => (
                      <td key={s}>{p.workload[s] ?? 0}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-600">{t('cases.rules.noPeople')}</p>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t('cases.rules.rules')}</h2>
        <p className="text-sm text-slate-700">{t('cases.rules.intro')}</p>
        {rules.data?.length ? (
          <ul className="flex flex-col gap-2" data-testid="rules">
            {rules.data.map((r, i) => {
              const label = r.name ?? t('cases.rules.unnamed', { n: i + 1 });
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 p-3 text-sm"
                >
                  <span className="font-medium">{label}</span>
                  <span>→ {r.userName}</span>
                  <span className="text-slate-700">{describe(r.filter)}</span>
                  {r.quota ? <span className="text-slate-600">≤ {r.quota}</span> : null}
                  <span className="text-xs text-slate-600">
                    {t('cases.rules.matching', {
                      matching: r.matching,
                      unassigned: r.unassigned,
                      held: r.assignedToUser,
                    })}
                  </span>
                  <label className="ml-auto flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={r.active}
                      onChange={(e) =>
                        patch.mutate({ id: r.id, body: { active: e.target.checked } })
                      }
                    />
                    {t('cases.rules.active')}
                  </label>
                  <button
                    type="button"
                    className={smallBtn}
                    aria-label={t('cases.rules.remove', { name: label })}
                    onClick={() => remove.mutate(r.id)}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{t('cases.rules.noRules')}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {t('cases.rules.apply')}
          </Button>
          <span role="status" aria-live="polite" className="text-sm">
            {message}
          </span>
        </div>
      </Card>

      <Card>
        <form
          className="flex max-w-3xl flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId && filter) create.mutate();
          }}
        >
          <h2 className="text-lg font-semibold">{t('cases.rules.add')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label={t('cases.rules.name')} value={name} onChange={setName} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{t('cases.rules.who')}</span>
              <select
                className={controlCls}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="">{t('cases.list.pickPerson')}</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label={t('cases.rules.quota')} integer value={quota} onChange={setQuota} />
          </div>
          <ConditionBuilder
            label={t('cases.rules.when')}
            value={filter}
            variables={variables}
            onChange={setFilter}
          />
          {preview ? (
            <p className="text-sm" data-testid="rule-preview">
              {t('cases.rules.preview', preview)}
            </p>
          ) : null}
          <ErrorText>{error}</ErrorText>
          <div>
            <Button type="submit" disabled={!userId || !filter || create.isPending}>
              {t('cases.rules.add')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
