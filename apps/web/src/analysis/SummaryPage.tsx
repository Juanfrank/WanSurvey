import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Button } from '../routes/ui.js';
import { BarTable, fmtNum, fmtPct, Progress } from './charts.js';
import { filterQuery, type DataFilters } from './ResultsTab.js';
import { ToplineItems, type ToplineItem } from './Topline.js';

export interface Summary {
  project: { name: string; code: string };
  questionnaire: { id: string; name: string };
  target: number | null;
  generatedAt: string;
  kpis: {
    completes: number;
    approved: number;
    byMode: Record<string, number>;
    medianMinutes: number | null;
    first: string | null;
    last: string | null;
  };
  items: ToplineItem[];
}

/** The printable summary (S3): KPIs and the topline, laid out for paper and PDF. */
export function SummaryView({ s, readOnly = false }: { s: Summary; readOnly?: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <article
      className="mx-auto flex max-w-4xl flex-col gap-6 print:max-w-none"
      data-testid="summary"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-2xl font-bold">
            {t('analysis.summary.title', { name: s.project.name })}
          </h1>
          <p className="text-slate-600">
            {s.questionnaire.name} ·{' '}
            {t('analysis.summary.generated', { date: date(s.generatedAt) })}
          </p>
          {s.kpis.first && s.kpis.last ? (
            <p className="text-slate-600">
              {t('analysis.summary.period', { from: date(s.kpis.first), to: date(s.kpis.last) })}
            </p>
          ) : null}
          {readOnly ? (
            <p className="mt-1 text-sm text-slate-600">{t('analysis.summary.readOnly')}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          className="print:hidden"
          onClick={() => window.print()}
        >
          {t('analysis.summary.print')}
        </Button>
      </header>
      <section
        className="grid grid-cols-2 gap-4 sm:grid-cols-4"
        aria-label={t('analysis.summary.kpis')}
      >
        {(
          [
            ['completes', String(s.kpis.completes)],
            ['target', s.target ? String(s.target) : '–'],
            [
              'approved',
              `${s.kpis.approved} (${fmtPct(lang, s.kpis.completes ? s.kpis.approved / s.kpis.completes : null)})`,
            ],
            [
              'medianLength',
              s.kpis.medianMinutes === null
                ? '–'
                : t('analysis.summary.minutes', { n: fmtNum(lang, s.kpis.medianMinutes, 1) }),
            ],
          ] as const
        ).map(([k, v]) => (
          <div
            key={k}
            className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm"
          >
            <p className="eyebrow">{t(`analysis.summary.${k}`)}</p>
            <p className="mt-1.5 text-2xl font-bold tabular-nums text-navy">{v}</p>
          </div>
        ))}
      </section>
      {s.target ? (
        <Progress value={s.kpis.completes} max={s.target} label={t('analysis.summary.completes')} />
      ) : null}
      <BarTable
        caption={t('analysis.live.byMode')}
        rows={Object.entries(s.kpis.byMode).map(([m, n]) => ({
          key: m,
          label: t(`analysis.modes.${m}`, { defaultValue: m }),
          value: n,
          display: String(n),
        }))}
      />
      <h2 className="text-lg font-semibold">{t('analysis.results.title')}</h2>
      <ToplineItems items={s.items} />
    </article>
  );
}

/** `/projects/$projectId/summary`, with the filters of the results tab in the address. */
export function SummaryPage() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const search = useSearch({ strict: false }) as DataFilters;
  const { t } = useTranslation();
  const qs = filterQuery(search);
  const s = useQuery({
    queryKey: ['summary', projectId, qs],
    queryFn: () => api<Summary>(`/projects/${projectId}/summary?${qs}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <nav className="text-sm text-slate-600 print:hidden">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'results' }}
          className="hover:underline"
        >
          ← {t('analysis.results.title')}
        </Link>
      </nav>
      {s.data ? <SummaryView s={s.data} /> : <p>…</p>}
    </div>
  );
}

/** `/share/$token`: a client's read-only summary, no account needed (M7). */
export function SharePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const { t } = useTranslation();
  const s = useQuery({
    queryKey: ['share', token],
    queryFn: () => api<Summary>(`/public/share/${encodeURIComponent(token)}`),
    retry: false,
  });
  useEffect(() => {
    if (s.data) document.title = `${s.data.project.name} · WanSurvey`;
  }, [s.data]);
  return (
    <main className="min-h-screen bg-white px-4 py-8">
      {s.data ? (
        <SummaryView s={s.data} readOnly />
      ) : s.isError ? (
        <p role="alert" className="mx-auto max-w-md text-center text-slate-700">
          {t('analysis.summary.notFound')}
        </p>
      ) : (
        <p className="text-center">…</p>
      )}
    </main>
  );
}
