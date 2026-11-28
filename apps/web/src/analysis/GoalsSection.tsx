import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useAssignees } from '../cases/hooks.js';
import { controlCls, inputCls } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';
import { Button, Drawer, ErrorText } from '../routes/ui.js';
import { CloseIcon } from '../routes/icons.js';
import { InfoTip } from '../cases/samplingControls.js';
import { wordsLocale } from '../format.js';

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
  const canAssign = useCan('cases.assign', projectId);
  const canSet = canAssign && manage;
  // Who may change the goals reaches them in a click: the settings' Goals topic.
  const canConfigure = useCan('projects.update', projectId);
  const canOpenGoals = canAssign || canConfigure;
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
  const blank = {
    userId: '',
    frequency: 'daily' as Frequency,
    questionnaireId: '',
    startsOn: today,
    endsOn: today,
    target: 10,
  };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  // The form of a new goal opens in a side panel from "+ Add goal" beside the title.
  const [adding, setAdding] = useState(false);
  const formId = useId();
  const closeAdding = () => {
    setAdding(false);
    setError(null);
  };
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
      setAdding(false);
      // The next goal starts from a blank form, not a copy of this one.
      setForm(blank);
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
    new Date(`${d}T12:00:00`).toLocaleDateString(wordsLocale(i18n.language), {
      dateStyle: 'medium',
    });
  const who = (g: Goal) => g.name ?? t('analysis.goals.team');
  const list = goals.data ?? [];
  // Two dates in the year of the second: "28 nov – 4 dic 2026".
  const range = (from: string, to: string) =>
    from.slice(0, 4) === to.slice(0, 4)
      ? `${new Date(`${from}T12:00:00`).toLocaleDateString(wordsLocale(i18n.language), { day: 'numeric', month: 'short' })} – ${date(to)}`
      : `${date(from)} – ${date(to)}`;
  // The current window of a recurring goal, and how many were due by today.
  const detail = (g: Goal) =>
    [
      g.frequency !== 'period' && g.windowFrom && g.windowTo
        ? g.windowFrom === g.windowTo
          ? date(g.windowFrom)
          : t('analysis.goals.window', { from: date(g.windowFrom), to: date(g.windowTo) })
        : null,
      (g.state === 'on_track' || g.state === 'behind') && g.expectedByToday < g.target
        ? t('analysis.goals.expected', { count: g.expectedByToday })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  // The questionnaire only matters when some goal counts a single one.
  const showQ = canSet && list.some((g) => g.questionnaireId);

  return (
    <section aria-labelledby="goals-title" className="flex flex-col gap-3" data-testid="goals">
      <div className="flex items-center gap-1">
        <h2 id="goals-title" className="text-lg font-semibold">
          {t('analysis.goals.title')}
        </h2>
        {/* Where the goals are set, the long explanation waits behind an ⓘ. */}
        {manage ? (
          <InfoTip
            id="goals-help"
            term={t('analysis.goals.title')}
            text={t('analysis.goals.help')}
            align="start"
          />
        ) : null}
        {canSet ? (
          <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            <span aria-hidden="true">+ </span>
            {t('analysis.goals.add')}
          </Button>
        ) : null}
      </div>
      {manage ? null : (
        <p className="max-w-4xl text-slate-600">
          {canOpenGoals ? (
            <>
              {t('analysis.goals.progressHelpLead')}{' '}
              <Link
                to="/projects/$projectId"
                params={{ projectId }}
                search={{ tab: 'settings', topic: 'fieldwork' }}
                className="font-medium text-indigo-ink-700 hover:underline"
              >
                {t('analysis.goals.progressHelpLink')}
              </Link>
              .
            </>
          ) : (
            t('analysis.goals.progressHelp')
          )}
        </p>
      )}
      {list.length ? (
        <div className="relative overflow-x-auto rounded-md border border-slate-200 bg-white">
          {/* One line per goal: the details of the progress are in its title. */}
          <table className="w-full [&_td]:whitespace-nowrap">
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
                {showQ ? (
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
                  <td className="px-2 py-1.5">{range(g.startsOn, g.endsOn)}</td>
                  {showQ ? (
                    <td
                      className="max-w-[10rem] truncate px-2 py-1.5"
                      title={qName(g.questionnaireId)}
                    >
                      {qName(g.questionnaireId)}
                    </td>
                  ) : null}
                  <td className="px-2 py-1.5" title={detail(g) || undefined}>
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2 w-12 flex-none overflow-hidden rounded-full bg-slate-100"
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
                        <span aria-hidden="true">
                          {t('analysis.goals.countShort', { done: g.completes, target: g.target })}
                        </span>
                        <span className="sr-only">
                          {t('analysis.goals.count', { done: g.completes, target: g.target })}
                        </span>
                      </span>
                      {/* The current window and the pace, for screen readers (a title for the eye). */}
                      {detail(g) ? <span className="sr-only">{detail(g)}</span> : null}
                    </div>
                  </td>
                  <td
                    className="px-2 py-1.5 tabular-nums"
                    data-testid="goal-total"
                    title={t('analysis.goals.count', {
                      done: g.periodCompletes,
                      target: g.periodTarget,
                    })}
                  >
                    {t('analysis.goals.countShort', {
                      done: g.periodCompletes,
                      target: g.periodTarget,
                    })}
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
                        className="grid h-7 w-7 place-items-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-red-ink-800"
                        title={t('analysis.goals.remove')}
                        onClick={() =>
                          window.confirm(t('analysis.goals.confirmRemove', { name: who(g) })) &&
                          remove.mutate(g.id)
                        }
                      >
                        <CloseIcon className="h-4 w-4" />
                        <span className="sr-only">
                          {t('analysis.goals.remove')} {who(g)}
                        </span>
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
      {canSet && adding ? (
        <Drawer
          title={t('analysis.goals.new')}
          onClose={closeAdding}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={closeAdding}>
                {t('analysis.goals.cancel')}
              </Button>
              <Button type="submit" form={formId} busy={create.isPending} disabled={!form.userId}>
                {t('analysis.goals.add')}
              </Button>
            </>
          }
        >
          <form
            id={formId}
            className="flex flex-col gap-3"
            aria-label={t('analysis.goals.new')}
            onSubmit={(e) => {
              e.preventDefault();
              if (!create.isPending) create.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('analysis.goals.person')}</span>
              <select
                className={controlCls}
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
                className={controlCls}
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
                className={controlCls}
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
            <ErrorText>{error}</ErrorText>
          </form>
        </Drawer>
      ) : null}
    </section>
  );
}
