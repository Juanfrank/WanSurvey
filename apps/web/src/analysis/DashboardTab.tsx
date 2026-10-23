import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../routes/ui.js';
import { BarTable, DayColumns, fmtPct, Progress } from './charts.js';

export interface LiveSnapshot {
  at: string;
  target: number | null;
  completes: number;
  byMode: Record<string, number>;
  byDay: { day: string; completes: number }[];
  quotas: { id: string; name: string; max: number; count: number }[];
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

/** The live dashboard (M2): Server-Sent Events, reconnecting on its own. */
export function DashboardTab({ projectId }: { projectId: string }) {
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

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });

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
            <DayColumns days={snap.byDay} />
          </Card>
          {snap.quotas.length ? (
            <Card className="flex flex-col gap-2">
              <h3 className="font-medium">{t('analysis.live.quotas')}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="quotas">
                  <thead>
                    <tr className="text-left text-slate-600">
                      <th scope="col">{t('analysis.live.quotaCell')}</th>
                      <th scope="col" className="pl-3 text-right">
                        {t('analysis.live.quotaCount')}
                      </th>
                      <th scope="col" className="pl-3 text-right">
                        {t('analysis.live.quotaMax')}
                      </th>
                      <th scope="col" className="w-1/3">
                        <span className="sr-only">%</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.quotas.map((q) => (
                      <tr key={q.id}>
                        <th scope="row" className="py-1 text-left font-normal">
                          {q.name}
                        </th>
                        <td className="pl-3 text-right tabular-nums">{q.count}</td>
                        <td className="pl-3 text-right tabular-nums">{q.max}</td>
                        <td className="pl-3">
                          <Progress value={q.count} max={q.max} label={q.name} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
          <Card className="flex flex-col gap-2">
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
        </div>
      )}
    </div>
  );
}
