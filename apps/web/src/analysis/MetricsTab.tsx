import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls } from '../designer/fields.js';
import { TableScroll } from '../routes/ui.js';
import { fmtNum, fmtPct } from './charts.js';
import { GoalsSection } from './GoalsSection.js';

const KEYS = [
  'completes',
  'perHour',
  'meanMinutes',
  'medianMinutes',
  'rr1',
  'coop1',
  'ref1',
  'con1',
  'dialsPerComplete',
  'itemNonResponse',
  'speeding',
  'straightlining',
  'rejectionRate',
  'backPerInterview',
  'syncLatencyS',
] as const;
type Key = (typeof KEYS)[number];
const RATES = new Set<Key>([
  'rr1',
  'coop1',
  'ref1',
  'con1',
  'itemNonResponse',
  'speeding',
  'straightlining',
  'rejectionRate',
]);

/**
 * The direction in which an unusual value calls for a look at the interviewer's work (rushed
 * interviews, many refusals…); the other direction is only unusual.
 */
const CONCERN: Partial<Record<Key, -1 | 1>> = {
  perHour: 1,
  meanMinutes: -1,
  medianMinutes: -1,
  rr1: -1,
  coop1: -1,
  ref1: 1,
  con1: -1,
  dialsPerComplete: 1,
  itemNonResponse: 1,
  speeding: 1,
  straightlining: 1,
  rejectionRate: 1,
  backPerInterview: 1,
  syncLatencyS: 1,
};

const medianOf = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface Row {
  interviewerId: string;
  name: string;
  values: Record<Key, number | null>;
  outliers: Partial<Record<Key, -1 | 1>>;
}

/** Interviewer metrics (M4, M5): the team ranked with outliers, or one's own figures. */
export function MetricsTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [mode, setMode] = useState('');
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: 'completes', desc: true });
  const qs = new URLSearchParams({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(mode ? { mode } : {}),
  });
  const data = useQuery({
    queryKey: ['metrics', projectId, qs.toString()],
    queryFn: () =>
      api<{ team: boolean; interviewers: Row[] }>(
        `/projects/${projectId}/metrics/interviewers?${qs}`,
      ),
  });
  const rows = [...(data.data?.interviewers ?? [])].sort((a, b) => {
    const x = a.values[sort.key] ?? -Infinity;
    const y = b.values[sort.key] ?? -Infinity;
    return (sort.desc ? y - x : x - y) || a.name.localeCompare(b.name);
  });
  const medians = Object.fromEntries(
    KEYS.map((k) => [
      k,
      medianOf(rows.map((r) => r.values[k]).filter((v): v is number => v !== null)),
    ]),
  ) as Record<Key, number | null>;
  /** What an unusual value means, in words: shown on hover and read by screen readers. */
  const explain = (k: Key, o: -1 | 1, v: number | null) =>
    t(o > 0 ? 'analysis.metrics.outlierTipHigh' : 'analysis.metrics.outlierTipLow', {
      name: t(`analysis.metrics.keys.${k}`),
      value: show(k, v),
      median: show(k, medians[k]),
    }) +
    ' ' +
    t(CONCERN[k] === o ? 'analysis.metrics.outlierCheck' : 'analysis.metrics.outlierFine');
  function show(k: Key, v: number | null) {
    return RATES.has(k)
      ? fmtPct(i18n.language, v, 1)
      : fmtNum(i18n.language, v, k === 'completes' ? 0 : 1);
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="metrics">
      <GoalsSection projectId={projectId} />
      <h2 className="text-lg font-semibold">
        {data.data && !data.data.team ? t('analysis.metrics.mine') : t('analysis.metrics.title')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          {t('analysis.metrics.from')}
          <input
            type="date"
            className={controlCls}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          {t('analysis.metrics.to')}
          <input
            type="date"
            className={controlCls}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          {t('analysis.metrics.mode')}
          <select className={controlCls} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">{t('analysis.metrics.anyMode')}</option>
            {(['CATI', 'CAPI', 'CAWI', 'PAPI'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`analysis.modes.${m}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!rows.length ? (
        <p className="text-slate-600">{data.isLoading ? '…' : t('analysis.metrics.none')}</p>
      ) : (
        <>
          <TableScroll
            label={data.data?.team ? t('analysis.metrics.title') : t('analysis.metrics.mine')}
            className="rounded-lg border border-slate-200 bg-white"
          >
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left align-bottom"
                  >
                    {t('analysis.metrics.interviewer')}
                  </th>
                  {KEYS.map((k) => (
                    <th
                      key={k}
                      scope="col"
                      className="w-28 min-w-24 px-2 py-2 text-right align-bottom font-medium"
                      aria-sort={
                        sort.key === k ? (sort.desc ? 'descending' : 'ascending') : undefined
                      }
                    >
                      <button
                        type="button"
                        className="text-right hover:underline"
                        aria-label={t('analysis.metrics.sortBy', {
                          name: t(`analysis.metrics.keys.${k}`),
                        })}
                        onClick={() =>
                          setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }))
                        }
                      >
                        {t(`analysis.metrics.keys.${k}`)}
                        {sort.key === k ? (sort.desc ? ' ↓' : ' ↑') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.interviewerId} data-testid="metrics-row">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-medium"
                    >
                      {r.name}
                    </th>
                    {KEYS.map((k) => {
                      const o = r.outliers[k];
                      return (
                        <td
                          key={k}
                          className={`px-2 py-1.5 text-right tabular-nums ${
                            !o
                              ? ''
                              : CONCERN[k] === o
                                ? 'bg-amber-100 font-semibold text-amber-ink-950'
                                : 'bg-slate-100 font-semibold text-slate-900'
                          }`}
                          data-outlier={o ?? undefined}
                          data-concern={o && CONCERN[k] === o ? true : undefined}
                          title={o ? explain(k, o, r.values[k]) : undefined}
                        >
                          {show(k, r.values[k])}
                          {o ? (
                            <span className="sr-only"> ({explain(k, o, r.values[k])})</span>
                          ) : null}
                          {o ? <span aria-hidden="true">{o > 0 ? ' ▲' : ' ▼'}</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {data.data?.team ? (
            <p className="text-slate-600">{t('analysis.metrics.outlierNote')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
