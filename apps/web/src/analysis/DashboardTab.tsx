import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useCan } from '../designer/hooks.js';
import { DevicesCard } from '../device/DevicesCard.js';
import { Card } from '../routes/ui.js';
import { InfoTip } from '../cases/samplingControls.js';
import { BarTable, DayColumns, fmtNum, fmtPct, Progress } from './charts.js';
import {
  fieldPace,
  PACE_DAYS,
  planProgress,
  quotaStatus,
  type PaceState,
  type QuotaState,
} from './pace.js';
import { locale, wordsLocale } from '../format.js';

export interface LiveSnapshot {
  at: string;
  target: number | null;
  completes: number;
  byMode: Record<string, number>;
  byDay: { day: string; completes: number }[];
  /** Today in the project's time zone and the planned fieldwork dates. */
  plan?: { today: string; startsOn: string | null; endsOn: string | null };
  quotas: { id: string; name: string; max: number; target?: number | null; count: number }[];
  field: {
    cases: number;
    byStatus: Record<string, number>;
    byDisposition: Record<string, number>;
    callbacksDue: number;
  };
  funnel: Record<'total' | 'sent' | 'opened' | 'started' | 'completed' | 'bounced', number> | null;
  active: {
    userId: string;
    name: string;
    mode: string;
    caseId: string | null;
    externalId: string | null;
    lastAt: string;
  }[];
}

const MODES = ['CATI', 'CAPI', 'CAWI', 'PAPI'] as const;
const STATUSES = ['fresh', 'assigned', 'in_progress', 'finalised', 'withdrawn'] as const;
const FUNNEL = ['total', 'sent', 'opened', 'started', 'completed', 'bounced'] as const;

const PILL = 'rounded px-1.5 py-0.5 text-xs font-medium';
const PACE_CLS: Record<PaceState, string> = {
  upcoming: 'bg-slate-100 text-slate-800',
  on_track: 'bg-emerald-100 text-emerald-ink-900',
  met: 'bg-emerald-100 text-emerald-ink-900',
  behind: 'bg-amber-100 text-amber-ink-900',
  ended: 'bg-red-100 text-red-ink-900',
};
const QUOTA_CLS: Record<QuotaState, string> = {
  behind: 'bg-amber-100 text-amber-ink-900',
  near_full: 'bg-amber-100 text-amber-ink-900',
  on_track: 'bg-slate-100 text-slate-800',
  met: 'bg-emerald-100 text-emerald-ink-900',
  full: 'bg-red-100 text-red-ink-900',
};
const GOAL_CLS: Record<string, string> = {
  upcoming: 'bg-slate-100 text-slate-800',
  rest: 'bg-slate-100 text-slate-800',
  on_track: 'bg-emerald-100 text-emerald-ink-900',
  met: 'bg-emerald-100 text-emerald-ink-900',
  behind: 'bg-amber-100 text-amber-ink-900',
  missed: 'bg-red-100 text-red-ink-900',
};
const GOAL_ORDER: Record<string, number> = {
  behind: 0,
  missed: 1,
  on_track: 2,
  upcoming: 3,
  rest: 4,
  met: 5,
};
/** Goals shown on the dashboard; the rest are in Metrics. */
const GOALS_SHOWN = 5;

interface GoalRow {
  id: string;
  name: string | null;
  completes: number;
  target: number;
  frequency: string;
  state: string;
}

interface Risks {
  repeatedFlags: number;
  interviewers: {
    userId: string;
    name: string;
    pending: number;
    flagged: number;
    kinds: Record<string, number>;
  }[];
  expiringSoon: number | null;
  soonHours: number;
}

/**
 * The live dashboard (M2): Server-Sent Events, reconnecting on its own. `onGoals` opens where
 * the goals are set (the project settings), from the goals card.
 */
export function DashboardTab({ projectId, onGoals }: { projectId: string; onGoals?: () => void }) {
  const { t, i18n } = useTranslation();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/v1/projects/${projectId}/live`, { withCredentials: true });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('snapshot', (e) => {
      setSnap(JSON.parse((e as MessageEvent<string>).data) as LiveSnapshot);
      setLive(true);
    });
    return () => es.close();
  }, [projectId]);

  // Goals and risks name interviewers: for those who follow the team, not for clients.
  const canTeam = useCan('metrics.team', projectId);
  const canReview = useCan('interviews.review', projectId);
  const goals = useQuery({
    queryKey: ['goals', projectId],
    queryFn: () => api<GoalRow[]>(`/projects/${projectId}/goals`),
    enabled: canTeam,
  });
  // Re-read at most once a minute, following the snapshots.
  const risks = useQuery({
    queryKey: ['live-risks', projectId, snap?.at.slice(0, 16)],
    queryFn: () => api<Risks>(`/projects/${projectId}/live/risks`),
    enabled: canTeam && !!snap,
    placeholderData: (prev) => prev,
  });

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale(i18n.language), { hour: '2-digit', minute: '2-digit' });
  const day = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString(wordsLocale(i18n.language), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  const plan = snap?.plan;
  const pace =
    snap && plan
      ? fieldPace({
          target: snap.target,
          completes: snap.completes,
          startsOn: plan.startsOn,
          endsOn: plan.endsOn,
          today: plan.today,
          byDay: snap.byDay,
        })
      : null;
  const quotas = snap
    ? quotaStatus(
        snap.quotas.map((q) => ({ ...q, target: q.target ?? null })),
        plan ? planProgress(plan.startsOn, plan.endsOn, plan.today) : null,
      )
    : [];
  const quotasBehind = quotas.filter((q) => q.state === 'behind').length;
  // Goals needing attention first (behind, missed), as the quota cells.
  const goalList = [...(goals.data ?? [])].sort(
    (a, b) => (GOAL_ORDER[a.state] ?? 9) - (GOAL_ORDER[b.state] ?? 9),
  );
  // A full load: the project page reads its tab from the address when it opens.
  const href = (tab: string) => `/projects/${projectId}?tab=${tab}`;
  const riskItems = risks.data
    ? [
        ...(pace?.state === 'behind' && pace.requiredPerDay
          ? [{ key: 'pace', text: t('analysis.live.behindPace', { count: pace.requiredPerDay }) }]
          : []),
        ...(quotasBehind
          ? [{ key: 'quotas', text: t('analysis.live.quotasBehind', { count: quotasBehind }) }]
          : []),
        ...(risks.data.expiringSoon
          ? [
              {
                key: 'expiring',
                text: t('analysis.live.expiring', {
                  count: risks.data.expiringSoon,
                  hours: risks.data.soonHours,
                }),
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="dashboard">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t('analysis.live.title')}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            live ? 'bg-emerald-100 text-emerald-ink-900' : 'bg-amber-100 text-amber-ink-900'
          }`}
          data-testid="live-status"
        >
          {live ? t('analysis.live.connected') : t('analysis.live.reconnecting')}
        </span>
        {snap ? (
          <span className="text-slate-600" aria-live="polite">
            {t('analysis.live.updated', { time: time(snap.at) })}
          </span>
        ) : null}
      </div>
      {!snap ? (
        <p className="text-slate-600">…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3">
            <h3 className="eyebrow">{t('analysis.live.completes')}</h3>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-4xl font-bold tabular-nums text-navy" data-testid="completes">
                {snap.completes}
              </span>
              <span className="text-slate-600">
                {snap.target
                  ? t('analysis.live.ofTarget', {
                      target: snap.target,
                      pct: fmtPct(i18n.language, snap.completes / snap.target),
                    })
                  : t('analysis.live.noTarget')}
              </span>
            </p>
            {snap.target ? (
              <Progress
                value={snap.completes}
                max={snap.target}
                label={t('analysis.live.completes')}
              />
            ) : null}
            {pace && plan?.startsOn && plan.endsOn ? (
              <div className="flex flex-col gap-2" data-testid="pace">
                <p className="flex flex-wrap items-center gap-2 text-slate-600">
                  <span>
                    {t('analysis.live.plan', { from: day(plan.startsOn), to: day(plan.endsOn) })}
                    {pace.day > 0 && plan.today <= plan.endsOn
                      ? ` · ${t('analysis.live.planDay', { day: pace.day, total: pace.totalDays })}`
                      : ''}
                  </span>
                  <span className={`${PILL} ${PACE_CLS[pace.state]}`} data-testid="pace-state">
                    {t(`analysis.live.paceStates.${pace.state}`)}
                  </span>
                </p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div>
                    <dt className="text-xs text-slate-600">{t('analysis.live.expected')}</dt>
                    <dd className="font-semibold tabular-nums" data-testid="pace-expected">
                      {pace.expected}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-600">{t('analysis.live.required')}</dt>
                    <dd className="font-semibold tabular-nums" data-testid="pace-required">
                      {pace.requiredPerDay ?? '–'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-600">
                      {t('analysis.live.current', {
                        count: Math.min(PACE_DAYS, Math.max(1, pace.day)),
                      })}
                    </dt>
                    <dd className="font-semibold tabular-nums">
                      {pace.currentPerDay === null
                        ? '–'
                        : t('analysis.live.perDay', {
                            n: fmtNum(i18n.language, pace.currentPerDay, 1),
                          })}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-600">{t('analysis.live.forecast')}</dt>
                    <dd className="font-semibold tabular-nums" data-testid="pace-forecast">
                      {pace.forecast ? day(pace.forecast) : '–'}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : snap.target ? (
              <p className="text-slate-600">{t('analysis.live.noPlan')}</p>
            ) : null}
            <BarTable
              caption={t('analysis.live.byMode')}
              rows={MODES.filter((m) => snap.byMode[m] !== undefined).map((m) => ({
                key: m,
                label: t(`analysis.modes.${m}`),
                value: snap.byMode[m] ?? 0,
                display: String(snap.byMode[m] ?? 0),
              }))}
            />
          </Card>
          <Card className="flex flex-col gap-2">
            <h3 className="font-medium">{t('analysis.live.byDay')}</h3>
            <DayColumns
              days={snap.byDay}
              goal={
                pace?.requiredPerDay && (pace.state === 'on_track' || pace.state === 'behind')
                  ? {
                      value: pace.requiredPerDay,
                      label: t('analysis.live.requiredLine', { n: pace.requiredPerDay }),
                    }
                  : null
              }
            />
          </Card>
          {quotas.length ? (
            <Card className="flex flex-col gap-2 lg:col-span-2">
              {/* How the target is read, behind an ⓘ beside the title (not a paragraph). */}
              <h3 className="flex items-center gap-1 font-medium">
                {t('analysis.live.quotas')}
                <InfoTip
                  id="live-quotas"
                  term={t('analysis.live.quotas')}
                  text={t('analysis.live.quotaHelp')}
                  align="start"
                />
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="quotas">
                  <thead>
                    <tr className="text-left text-slate-600">
                      <th scope="col">{t('analysis.live.quotaCell')}</th>
                      <th scope="col" className="pl-3 text-right">
                        {t('analysis.live.quotaCount')}
                      </th>
                      <th scope="col" className="pl-3 text-right">
                        {t('analysis.live.quotaAim')}
                      </th>
                      <th scope="col" className="pl-3 text-right">
                        {t('analysis.live.quotaMax')}
                      </th>
                      <th scope="col" className="pl-3 text-right">
                        %
                      </th>
                      <th scope="col" className="pl-3 text-right">
                        {t('analysis.live.quotaMissing')}
                      </th>
                      <th scope="col" className="pl-3">
                        {t('analysis.live.quotaState')}
                      </th>
                      <th scope="col" className="w-1/4">
                        <span className="sr-only">{t('analysis.live.quotaAim')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {quotas.map((q) => (
                      <tr key={q.id} data-quota={q.id} data-state={q.state}>
                        <th scope="row" className="py-1 text-left font-normal">
                          {q.name}
                        </th>
                        <td className="pl-3 text-right tabular-nums">{q.count}</td>
                        <td className="pl-3 text-right tabular-nums">{q.aim}</td>
                        <td className="pl-3 text-right tabular-nums">{q.max}</td>
                        <td className="pl-3 text-right tabular-nums">
                          {fmtPct(i18n.language, q.share)}
                        </td>
                        <td className="pl-3 text-right tabular-nums">{q.missing}</td>
                        <td className="pl-3">
                          <span className={`${PILL} whitespace-nowrap ${QUOTA_CLS[q.state]}`}>
                            {t(`analysis.live.quotaStates.${q.state}`)}
                          </span>
                          {q.state === 'behind' && q.expected !== null ? (
                            <span className="block text-xs text-slate-600">
                              {t('analysis.live.quotaExpected', { count: q.expected })}
                            </span>
                          ) : null}
                        </td>
                        <td className="pl-3">
                          <Progress value={q.count} max={q.aim} label={q.name} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
          {canTeam && (goalList.length || onGoals) ? (
            <Card className="flex flex-col gap-2">
              <h3 className="font-medium">{t('analysis.live.goals')}</h3>
              {goals.isSuccess && !goalList.length ? (
                <p className="text-slate-600">{t('analysis.goals.none')}</p>
              ) : null}
              <ul className="divide-y divide-slate-100 empty:hidden" data-testid="dashboard-goals">
                {goalList.slice(0, GOALS_SHOWN).map((g) => (
                  <li
                    key={g.id}
                    data-goal={g.name ?? 'team'}
                    className="flex flex-wrap items-center justify-between gap-2 py-1"
                  >
                    <span className="font-medium">{g.name ?? t('analysis.goals.team')}</span>
                    <span className="flex items-center gap-2 text-slate-600">
                      <span className="tabular-nums">
                        {t('analysis.goals.count', { done: g.completes, target: g.target })}{' '}
                        {t(`analysis.goals.per.${g.frequency}`)}
                      </span>
                      <span className={`${PILL} ${GOAL_CLS[g.state] ?? ''}`}>
                        {t(`analysis.goals.states.${g.state}`)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                {goalList.length ? (
                  <a className="text-indigo-ink-700 underline" href={href('metrics')}>
                    {t('analysis.live.goalsSeeAll')}
                  </a>
                ) : null}
                {onGoals ? (
                  <button type="button" className="text-indigo-ink-700 underline" onClick={onGoals}>
                    {t('analysis.live.setGoals')}
                  </button>
                ) : null}
              </p>
            </Card>
          ) : null}
          {canTeam && risks.data ? (
            <Card className="flex flex-col gap-2">
              <h3 className="font-medium">{t('analysis.live.risks')}</h3>
              {riskItems.length || risks.data.interviewers.length ? (
                <ul className="flex flex-col gap-1" data-testid="risks">
                  {riskItems.map((r) => (
                    <li key={r.key} data-risk={r.key}>
                      {r.text}
                    </li>
                  ))}
                  {risks.data.interviewers.map((r) => (
                    <li key={r.userId} data-risk="interviewer">
                      <span className="font-medium">{r.name}</span>
                      {': '}
                      {t('analysis.live.flagged', { flagged: r.flagged, pending: r.pending })}
                      <span className="block text-xs text-slate-600">
                        {Object.entries(r.kinds)
                          .sort((a, b) => b[1] - a[1])
                          .map(([k, n]) => `${t(`review.flags.${k}`, { defaultValue: k })} (${n})`)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-600">{t('analysis.live.risksNone')}</p>
              )}
              {canReview && risks.data.interviewers.length ? (
                <a className="text-indigo-ink-700 underline" href={href('review')}>
                  {t('analysis.live.reviewQueue')}
                </a>
              ) : null}
            </Card>
          ) : null}
          <Card className="flex flex-col gap-3">
            <h3 className="font-medium">
              {t('analysis.live.field')} · {snap.field.cases}
            </h3>
            <BarTable
              rows={STATUSES.map((s) => ({
                key: s,
                label: t(`analysis.live.statuses.${s}`),
                value: snap.field.byStatus[s] ?? 0,
                display: String(snap.field.byStatus[s] ?? 0),
              }))}
            />
            <p>
              {t('analysis.live.callbacksDue')}:{' '}
              <strong className="tabular-nums">{snap.field.callbacksDue}</strong>
            </p>
            {Object.keys(snap.field.byDisposition).length ? (
              <BarTable
                caption={t('analysis.live.dispositions')}
                rows={Object.entries(snap.field.byDisposition)
                  .sort((a, b) => b[1] - a[1])
                  .map(([d, n]) => ({
                    key: d,
                    label: t(`analysis.dispositionLabels.${d}`, { defaultValue: d }),
                    value: n,
                    display: String(n),
                  }))}
              />
            ) : null}
          </Card>
          {snap.funnel ? (
            <Card className="flex flex-col gap-2">
              <h3 className="font-medium">{t('analysis.live.funnel')}</h3>
              <BarTable
                rows={FUNNEL.map((k) => ({
                  key: k,
                  label: t(`analysis.live.funnelSteps.${k}`),
                  value: snap.funnel![k],
                  display: String(snap.funnel![k]),
                  muted: k === 'bounced',
                }))}
              />
            </Card>
          ) : null}
          {/* As tall as its list, not as the case figures beside it. */}
          <Card className="flex flex-col gap-2 self-start">
            <h3 className="font-medium">{t('analysis.live.active')}</h3>
            {snap.active.length ? (
              <ul className="divide-y divide-slate-100" data-testid="active">
                {snap.active.map((a) => (
                  <li key={a.userId} className="flex flex-wrap justify-between gap-2 py-1">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-slate-600">
                      {t(`analysis.modes.${a.mode}`)}
                      {a.externalId
                        ? ` · ${t('analysis.live.activeCase', { id: a.externalId })}`
                        : ''}
                      {' · '}
                      {time(a.lastAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-600">{t('analysis.live.noneActive')}</p>
            )}
          </Card>
          {/* Who holds cases on a device and when it last synchronised (169). */}
          {canTeam ? <DevicesCard projectId={projectId} at={snap.at} /> : null}
        </div>
      )}
    </div>
  );
}
