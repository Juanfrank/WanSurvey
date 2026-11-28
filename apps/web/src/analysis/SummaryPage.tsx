import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { Button, ErrorText } from '../routes/ui.js';
import { BarTable, fmtNum, fmtPct, Progress } from './charts.js';
import { filterQuery, UnreviewedNotice, type DataFilters } from './ResultsTab.js';
import { ToplineItems, type ToplineItem } from './Topline.js';
import { wordsLocale } from '../format.js';

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
  /** The filters applied (a client link may fix approved interviews only). */
  filters?: DataFilters;
  /** How fieldwork is going, for the whole project (older APIs: absent). */
  field?: FieldProgress;
}

interface FieldProgress {
  byDay: { day: string; completes: number }[];
  quotas: { id: string; name: string; max: number; count: number }[];
  cases: number;
  byStatus: Record<string, number>;
  byDisposition: Record<string, number>;
}

const STATUSES = ['fresh', 'assigned', 'in_progress', 'finalised', 'withdrawn'] as const;

/** The fieldwork part of the report: cases, final outcomes, quotas and the latest days. */
function FieldSection({ f, lang }: { f: FieldProgress; lang: string }) {
  const { t } = useTranslation();
  const dispositions = Object.entries(f.byDisposition).sort((a, b) => b[1] - a[1]);
  const days = f.byDay.filter((d) => d.completes > 0).slice(-14);
  const date = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString(wordsLocale(lang), {
      day: 'numeric',
      month: 'short',
    });
  return (
    <section
      className="flex flex-col gap-4 break-inside-avoid"
      aria-labelledby="field-progress"
      data-testid="field-progress"
    >
      <h2 id="field-progress" className="text-lg font-semibold">
        {t('analysis.summary.field')}
      </h2>
      <p className="text-slate-600">{t('analysis.summary.fieldHelp')}</p>
      <div className="grid gap-6 sm:grid-cols-2">
        <BarTable
          caption={`${t('analysis.live.field')} · ${f.cases}`}
          rows={STATUSES.filter((k) => f.byStatus[k]).map((k) => ({
            key: k,
            label: t(`analysis.live.statuses.${k}`),
            value: f.byStatus[k] ?? 0,
            display: `${f.byStatus[k]} (${fmtPct(lang, f.cases ? (f.byStatus[k] ?? 0) / f.cases : null)})`,
          }))}
        />
        {dispositions.length ? (
          <BarTable
            caption={t('analysis.live.dispositions')}
            rows={dispositions.map(([d, n]) => ({
              key: d,
              label: t(`analysis.dispositionLabels.${d}`, { defaultValue: d }),
              value: n,
              display: String(n),
            }))}
          />
        ) : null}
        {f.quotas.length ? (
          <BarTable
            caption={t('analysis.live.quotas')}
            rows={f.quotas.map((q) => ({
              key: q.id,
              label: q.name,
              value: q.count,
              display: t('analysis.goals.count', { done: q.count, target: q.max }),
            }))}
            max={Math.max(1, ...f.quotas.map((q) => q.max))}
          />
        ) : null}
        {days.length ? (
          <BarTable
            caption={t('analysis.summary.lastDays')}
            rows={days.map((d) => ({
              key: d.day,
              label: date(d.day),
              value: d.completes,
              display: String(d.completes),
            }))}
          />
        ) : null}
      </div>
    </section>
  );
}

/** The printable summary (S3): KPIs and the topline, laid out for paper and PDF. */
export function SummaryView({ s, readOnly = false }: { s: Summary; readOnly?: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(wordsLocale(lang), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
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
      {s.filters?.approvedOnly ? (
        <p className="text-slate-600" data-testid="approved-only">
          {t('analysis.summary.approvedOnly')}
        </p>
      ) : (
        <UnreviewedNotice n={s.kpis.completes} approved={s.kpis.approved} />
      )}
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
      {s.field ? <FieldSection f={s.field} lang={lang} /> : null}
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
      {s.data ? (
        <SummaryView s={s.data} />
      ) : s.error ? (
        <ErrorText>{localiseError(t, s.error)}</ErrorText>
      ) : (
        <p aria-busy="true">…</p>
      )}
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
