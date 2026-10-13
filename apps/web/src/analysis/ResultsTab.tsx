import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { localiseError } from '../i18n-messages.js';
import { Button, Card, ErrorText } from '../routes/ui.js';
import { fmtPct } from './charts.js';
import { ToplineItems, type ToplineItem } from './Topline.js';

export interface DataFilters {
  questionnaireId?: string;
  mode?: string;
  from?: string;
  to?: string;
  approvedOnly?: boolean;
  where?: string;
}

export const filterQuery = (f: DataFilters) =>
  new URLSearchParams(
    Object.entries(f)
      .filter(([, v]) => v !== undefined && v !== '' && v !== false)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

interface Topline {
  questionnaire: { id: string; name: string };
  n: number;
  items: ToplineItem[];
  variables: { name: string; label: string }[];
}

interface Crosstab {
  row: { name: string; label: string; categories: { code: number; label: string }[] };
  col: { name: string; label: string; categories: { code: number; label: string }[] };
  counts: number[][];
  colTotals: number[];
  rowTotals: number[];
  total: number;
  colPercents: (number | null)[][];
}

/** Filters shared by the results, the summary and exports. */
export function FilterBar({
  projectId,
  value,
  onChange,
  variables,
}: {
  projectId: string;
  value: DataFilters;
  onChange: (f: DataFilters) => void;
  variables?: { name: string; label: string }[];
}) {
  const { t } = useTranslation();
  const qs = useQuery({
    queryKey: ['data-questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; version: number }[]>(
        `/projects/${projectId}/data/questionnaires`,
      ),
  });
  const [whereVar, whereCodes] = (value.where ?? ':').split(':');
  return (
    <fieldset className="flex flex-wrap items-end gap-3">
      <legend className="sr-only">{t('analysis.results.filters')}</legend>
      {(qs.data?.length ?? 0) > 1 ? (
        <label className="flex flex-col gap-1">
          {t('analysis.results.questionnaire')}
          <select
            className={controlCls}
            value={value.questionnaireId ?? qs.data![0]!.id}
            onChange={(e) => onChange({ ...value, questionnaireId: e.target.value, where: '' })}
          >
            {qs.data!.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name} (v{q.version})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1">
        {t('analysis.metrics.mode')}
        <select
          className={controlCls}
          value={value.mode ?? ''}
          onChange={(e) => onChange({ ...value, mode: e.target.value })}
        >
          <option value="">{t('analysis.metrics.anyMode')}</option>
          {(['CATI', 'CAPI', 'CAWI', 'PAPI'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`analysis.modes.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        {t('analysis.metrics.from')}
        <input
          type="date"
          className={controlCls}
          value={value.from ?? ''}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        {t('analysis.metrics.to')}
        <input
          type="date"
          className={controlCls}
          value={value.to ?? ''}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
      </label>
      {variables?.length ? (
        <div className="flex items-end gap-1">
          <label className="flex flex-col gap-1">
            {t('analysis.results.where')}
            <select
              className={controlCls}
              value={whereVar}
              onChange={(e) =>
                onChange({ ...value, where: e.target.value ? `${e.target.value}:` : '' })
              }
            >
              <option value="">{t('analysis.results.whereAny')}</option>
              {variables.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          {whereVar ? (
            <input
              aria-label={`${whereVar} =`}
              placeholder="1,2"
              className={`${controlCls} w-20`}
              value={whereCodes}
              onChange={(e) => onChange({ ...value, where: `${whereVar}:${e.target.value}` })}
            />
          ) : null}
        </div>
      ) : null}
      <label className="flex items-center gap-2 pb-2">
        <input
          type="checkbox"
          checked={!!value.approvedOnly}
          onChange={(e) => onChange({ ...value, approvedOnly: e.target.checked })}
        />
        {t('analysis.results.approvedOnly')}
      </label>
    </fieldset>
  );
}

/** Topline and crosstabs with filters (S1, S2), the summary and links for clients. */
export function ResultsTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const canShare = useCan('projects.update', projectId);
  const [filters, setFilters] = useState<DataFilters>({});
  // The "only where" filter applies once it has codes.
  const applied = { ...filters, where: /:.+/.test(filters.where ?? '') ? filters.where : '' };
  const qs = filterQuery(applied);
  const top = useQuery({
    queryKey: ['topline', projectId, qs],
    queryFn: () => api<Topline>(`/projects/${projectId}/topline?${qs}`),
  });
  const [row, setRow] = useState('');
  const [col, setCol] = useState('');
  const xt = useQuery({
    queryKey: ['crosstab', projectId, qs, row, col],
    queryFn: () =>
      api<Crosstab>(`/projects/${projectId}/crosstab?${qs}${qs ? '&' : ''}row=${row}&col=${col}`),
    enabled: !!row && !!col && row !== col,
  });
  const vars = top.data?.variables ?? [];

  return (
    <div className="flex flex-col gap-6 text-sm" data-testid="results">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('analysis.results.title')}</h2>
        <Link
          to="/projects/$projectId/summary"
          params={{ projectId }}
          search={Object.fromEntries(new URLSearchParams(qs))}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-50"
        >
          {t('analysis.results.openSummary')}
        </Link>
      </div>
      <FilterBar projectId={projectId} value={filters} onChange={setFilters} variables={vars} />
      <ErrorText>{top.error ? localiseError(t, top.error) : null}</ErrorText>
      {top.data ? (
        <>
          <p className="font-medium" aria-live="polite" data-testid="n">
            {t('analysis.results.n', { count: top.data.n })}
          </p>
          {top.data.n ? (
            <div className="grid gap-6 xl:grid-cols-2">
              <Card>
                <ToplineItems items={top.data.items} />
              </Card>
              <Card className="flex flex-col gap-3 self-start">
                <h3 className="font-medium">{t('analysis.results.crosstab')}</h3>
                <div className="flex flex-wrap gap-3">
                  {(
                    [
                      ['rows', row, setRow],
                      ['cols', col, setCol],
                    ] as const
                  ).map(([k, v, set]) => (
                    <label key={k} className="flex flex-col gap-1">
                      {t(`analysis.results.${k}`)}
                      <select
                        className={controlCls}
                        value={v}
                        onChange={(e) => set(e.target.value)}
                      >
                        <option value="">{t('analysis.results.pick')}</option>
                        {vars.map((x) => (
                          <option key={x.name} value={x.name}>
                            {x.name} · {x.label.slice(0, 50)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                {xt.data ? <CrosstabTable x={xt.data} lang={i18n.language} /> : null}
              </Card>
            </div>
          ) : (
            <p className="text-slate-600">{t('analysis.results.noData')}</p>
          )}
        </>
      ) : null}
      {canShare ? <ShareLinks projectId={projectId} /> : null}
    </div>
  );
}

export function CrosstabTable({ x, lang }: { x: Crosstab; lang: string }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm" data-testid="crosstab">
        <caption className="mb-1 text-left text-slate-600">
          {x.row.name} × {x.col.name}. {t('analysis.results.colPct')}
        </caption>
        <thead>
          <tr className="border-b border-slate-200">
            <td />
            {x.col.categories.map((c) => (
              <th key={c.code} scope="col" className="px-2 py-1 text-right font-medium">
                {c.label}
              </th>
            ))}
            <th scope="col" className="px-2 py-1 text-right font-medium">
              {t('analysis.results.total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {x.row.categories.map((r, i) => (
            <tr key={r.code} className="border-b border-slate-100">
              <th scope="row" className="py-1 pr-2 text-left font-normal">
                {r.label}
              </th>
              {x.col.categories.map((c, j) => (
                <td key={c.code} className="px-2 py-1 text-right tabular-nums">
                  {fmtPct(lang, x.colPercents[i]![j] === null ? null : x.colPercents[i]![j]! / 100)}{' '}
                  <span className="text-slate-500">[{x.counts[i]![j]}]</span>
                </td>
              ))}
              <td className="px-2 py-1 text-right tabular-nums">{x.rowTotals[i]}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-1 pr-2 text-left font-medium">
              {t('analysis.results.total')}
            </th>
            {x.colTotals.map((n, j) => (
              <td key={j} className="px-2 py-1 text-right font-medium tabular-nums">
                {n}
              </td>
            ))}
            <td className="px-2 py-1 text-right font-medium tabular-nums">{x.total}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

interface ShareLink {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  url: string | null;
}

function ShareLinks({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [days, setDays] = useState('30');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const links = useQuery({
    queryKey: ['share-links', projectId],
    queryFn: () => api<ShareLink[]>(`/projects/${projectId}/share-links`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['share-links', projectId] });
  const create = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/share-links`, {
        method: 'POST',
        body: { days: days ? Number(days) : null },
      }),
    onSuccess: refresh,
    onError: (e) => setError(localiseError(t, e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/share-links/${id}/revoke`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
  return (
    <Card className="flex flex-col gap-3">
      <h3 className="font-medium">{t('analysis.results.share.title')}</h3>
      <p className="text-slate-600">{t('analysis.results.share.help')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          {t('analysis.results.share.days')}
          <input
            type="number"
            min={1}
            max={365}
            className={`${controlCls} w-24`}
            value={days}
            placeholder={t('analysis.results.share.forever')}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
        <Button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
          {t('analysis.results.share.create')}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {links.data?.length ? (
        <ul className="divide-y divide-slate-100" data-testid="share-links">
          {links.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
              {l.url ? (
                <>
                  <input
                    readOnly
                    aria-label={t('analysis.share.url')}
                    className={`${controlCls} min-w-0 flex-1 font-mono text-xs`}
                    value={l.url}
                  />
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={async () => {
                      await navigator.clipboard?.writeText(l.url!);
                      setCopied(l.id);
                    }}
                  >
                    {copied === l.id
                      ? t('analysis.results.share.copied')
                      : t('analysis.results.share.copy')}
                  </button>
                  <span className="text-slate-600">
                    {l.expiresAt
                      ? t('analysis.results.share.expires', { date: date(l.expiresAt) })
                      : t('analysis.results.share.forever')}
                  </span>
                  <button type="button" className={smallBtn} onClick={() => revoke.mutate(l.id)}>
                    {t('analysis.results.share.revoke')}
                  </button>
                </>
              ) : (
                <span className="text-slate-500">
                  {date(l.createdAt)} · {t('analysis.results.share.revoked')}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-600">{t('analysis.results.share.none')}</p>
      )}
    </Card>
  );
}
