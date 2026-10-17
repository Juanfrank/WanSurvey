import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useAssignees } from '../cases/hooks.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';
import { Button, ErrorText } from '../routes/ui.js';

const FREQUENCIES = ['period', 'daily', 'business_days', 'weekly', 'monthly'] as const;
type Frequency = (typeof FREQUENCIES)[number];

interface Goal {
  id: string;
  /** Null: the whole team. */
  userId: string | null;
  name: string | null;
  frequency: Frequency;
  questionnaireId: string | null;
  startsOn: string;
  endsOn: string;
  target: number;
  windowFrom: string | null;
  windowTo: string | null;
  completes: number;
  percent: number;
  expectedByToday: number;
  periodCompletes: number;
  periodTarget: number;
  state: 'upcoming' | 'on_track' | 'behind' | 'met' | 'missed' | 'rest';
}

const STATE_CLS: Record<Goal['state'], string> = {
  upcoming: 'bg-slate-100 text-slate-800',
  rest: 'bg-slate-100 text-slate-800',
  on_track: 'bg-emerald-100 text-emerald-ink-900',
  met: 'bg-emerald-100 text-emerald-ink-900',
  behind: 'bg-amber-100 text-amber-ink-900',
  missed: 'bg-red-100 text-red-ink-900',
};

/**
 * Goals: completes to reach between two dates, once for the period or each day, business day,
 * week or month, for one person or the whole team. With `manage` (project settings) they are
 * set and removed; otherwise (metrics) only their progress shows, each person seeing theirs.
 */
export function GoalsSection({
  projectId,
  manage = false,
}: {
  projectId: string;
  manage?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const canSet = useCan('cases.assign', projectId) && manage;
  const goals = useQuery({
    queryKey: ['goals', projectId],
    queryFn: () => api<Goal[]>(`/projects/${projectId}/goals`),
  });
  const people = useAssignees(projectId, canSet);
  const questionnaires = useQuery({
    queryKey: ['questionnaires', projectId],
    queryFn: () => api<{ id: string; name: string }[]>(`/projects/${projectId}/questionnaires`),
    enabled: canSet,
  });
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    userId: '',
    frequency: 'daily' as Frequency,
    questionnaireId: '',
    startsOn: today,
    endsOn: today,
    target: 10,
  });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['goals', projectId] });
  const create = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/goals`, {
        method: 'POST',
        body: {
          ...form,
          // "team" in the picker: the whole team.
          userId: form.userId === 'team' ? null : form.userId,
          questionnaireId: form.questionnaireId || null,
        },
      }),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/projects/${projectId}/goals/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const qName = (id: string | null) =>
    id ? (questionnaires.data?.find((q) => q.id === id)?.name ?? '…') : t('analysis.goals.anyQ');
  const date = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(i18n.language, { dateStyle: 'medium' });
  const who = (g: Goal) => g.name ?? t('analysis.goals.team');
  const list = goals.data ?? [];

  return (
    <section aria-labelledby="goals-title" className="flex flex-col gap-3" data-testid="goals">
      <h2 id="goals-title" className="text-lg font-semibold">
        {t('analysis.goals.title')}
      </h2>
      <p className="max-w-4xl text-slate-600">
        {manage ? t('analysis.goals.help') : t('analysis.goals.progressHelp')}
      </p>
      {list.length ? (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[48rem]">
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                <th scope="col" className="px-2 py-2">
                  {t('analysis.goals.person')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('analysis.goals.frequency')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('analysis.goals.period')}
                </th>
                {canSet ? (
                  <th scope="col" className="px-2 py-2">
                    {t('analysis.goals.questionnaire')}
                  </th>
                ) : null}
                <th scope="col" className="px-2 py-2">
                  {t('analysis.goals.progress')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('analysis.goals.whole')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('analysis.goals.state')}
                </th>
                {canSet ? (
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">{t('analysis.goals.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((g) => (
                <tr key={g.id} data-goal={who(g)}>
                  <td className="px-2 py-1.5 font-medium">{who(g)}</td>
                  <td className="px-2 py-1.5">
                    {g.target} {t(`analysis.goals.per.${g.frequency}`)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {date(g.startsOn)} – {date(g.endsOn)}
                  </td>
                  {canSet ? <td className="px-2 py-1.5">{qName(g.questionnaireId)}</td> : null}
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2 w-28 overflow-hidden rounded-full bg-slate-100"
                        role="progressbar"
                        aria-label={t('analysis.goals.progressOf', { name: who(g) })}
                        aria-valuemin={0}
                        aria-valuemax={g.target}
                        aria-valuenow={Math.min(g.completes, g.target)}
                      >
                        <div
                          className="h-full bg-indigo-600"
                          style={{ width: `${Math.min(100, g.percent)}%` }}
                        />
                      </div>
                      <span className="tabular-nums" data-testid="goal-count">
                        {t('analysis.goals.count', { done: g.completes, target: g.target })}
                      </span>
                    </div>
                    <span className="text-xs text-slate-600">
                      {g.frequency !== 'period' && g.windowFrom && g.windowTo
                        ? g.windowFrom === g.windowTo
                          ? date(g.windowFrom)
                          : t('analysis.goals.window', {
                              from: date(g.windowFrom),
                              to: date(g.windowTo),
                            })
                        : null}
                      {(g.state === 'on_track' || g.state === 'behind') &&
                      g.expectedByToday < g.target
                        ? ` · ${t('analysis.goals.expected', { count: g.expectedByToday })}`
                        : null}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 tabular-nums" data-testid="goal-total">
                    {t('analysis.goals.count', { done: g.periodCompletes, target: g.periodTarget })}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATE_CLS[g.state]}`}>
                      {t(`analysis.goals.states.${g.state}`)}
                    </span>
                  </td>
                  {canSet ? (
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        className={smallBtn}
                        onClick={() =>
                          window.confirm(t('analysis.goals.confirmRemove', { name: who(g) })) &&
                          remove.mutate(g.id)
                        }
                      >
                        {t('analysis.goals.remove')}
                        <span className="sr-only"> {who(g)}</span>
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-slate-600">{t('analysis.goals.none')}</p>
      )}
      {canSet ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3"
          aria-label={t('analysis.goals.new')}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('analysis.goals.person')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={form.userId}
              required
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
            >
              <option value="">{t('cases.list.pickPerson')}</option>
              <option value="team">{t('analysis.goals.team')}</option>
              {(people.data ?? []).map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('analysis.goals.frequency')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={form.frequency}
              onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`analysis.goals.frequencies.${f}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('analysis.goals.target')}</span>
            <input
              type="number"
              min={1}
              className={`${controlCls} w-24`}
              value={form.target}
              onChange={(e) => setForm({ ...form, target: Math.max(1, Number(e.target.value)) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('analysis.goals.from')}</span>
            <input
              type="date"
              className={inputCls}
              value={form.startsOn}
              required
              onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('analysis.goals.to')}</span>
            <input
              type="date"
              className={inputCls}
              value={form.endsOn}
              min={form.startsOn}
              required
              onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('analysis.goals.questionnaire')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={form.questionnaireId}
              onChange={(e) => setForm({ ...form, questionnaireId: e.target.value })}
            >
              <option value="">{t('analysis.goals.anyQ')}</option>
              {(questionnaires.data ?? []).map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" disabled={!form.userId || create.isPending}>
            {t('analysis.goals.add')}
          </Button>
          <ErrorText>{error}</ErrorText>
        </form>
      ) : null}
    </section>
  );
}
