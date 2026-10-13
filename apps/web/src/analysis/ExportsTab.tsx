import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button, Card, ErrorText } from '../routes/ui.js';
import { FilterBar, type DataFilters } from './ResultsTab.js';
import { fileSize } from '../format.js';

const FORMATS = ['csv', 'xlsx', 'sav', 'dta', 'codebook'] as const;

interface ExportRow {
  id: string;
  options: { format: (typeof FORMATS)[number] };
  status: 'queued' | 'running' | 'done' | 'failed';
  fileName: string | null;
  size: number | null;
  rows: number | null;
  error: string | null;
  createdAt: string;
}

const kb = (n: number | null) => (n === null ? '–' : fileSize(n));

/** Data exports (M6): request a file, watch it being built, download it. */
export function ExportsTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('csv');
  const [labels, setLabels] = useState<'codes' | 'labels'>('codes');
  const [rosters, setRosters] = useState<'wide' | 'long'>('wide');
  const [paradata, setParadata] = useState(false);
  const [filters, setFilters] = useState<DataFilters>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['exports', projectId],
    queryFn: () => api<ExportRow[]>(`/projects/${projectId}/exports`),
    // Exports being built are checked every second and a half until they are ready.
    refetchInterval: (q) =>
      q.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 1500 : false,
  });
  const request = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/exports`, {
        method: 'POST',
        body: {
          format,
          labels,
          rosters,
          paradata,
          approvedOnly: !!filters.approvedOnly,
          ...(filters.questionnaireId ? { questionnaireId: filters.questionnaireId } : {}),
          ...(filters.mode ? { mode: filters.mode } : {}),
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
        },
      }),
    onSuccess: async () => {
      setError(null);
      setMessage(t('analysis.exports.requested'));
      await qc.invalidateQueries({ queryKey: ['exports', projectId] });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const radio = <T extends string>(
    name: string,
    value: T,
    set: (v: T) => void,
    options: readonly T[],
    label: (v: T) => string,
  ) => (
    <div className="flex flex-wrap gap-3">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-1.5">
          <input type="radio" name={name} checked={value === o} onChange={() => set(o)} />
          {label(o)}
        </label>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-6 text-sm" data-testid="exports">
      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t('analysis.exports.title')}</h2>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
        >
          <label className="flex flex-col gap-1">
            {t('analysis.exports.format')}
            <select
              className={`${controlCls} w-60`}
              value={format}
              onChange={(e) => setFormat(e.target.value as (typeof FORMATS)[number])}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`analysis.exports.formats.${f}`)}
                </option>
              ))}
            </select>
          </label>
          {format === 'csv' || format === 'xlsx' ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1">{t('analysis.exports.labels')}</legend>
              {radio('labels', labels, setLabels, ['codes', 'labels'] as const, (v) =>
                t(`analysis.exports.labelOptions.${v}`),
              )}
            </fieldset>
          ) : null}
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1">{t('analysis.exports.rosters')}</legend>
            {radio('rosters', rosters, setRosters, ['wide', 'long'] as const, (v) =>
              t(`analysis.exports.rosterOptions.${v}`),
            )}
          </fieldset>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={paradata}
              onChange={(e) => setParadata(e.target.checked)}
            />
            {t('analysis.exports.paradata')}
          </label>
          <FilterBar projectId={projectId} value={filters} onChange={setFilters} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={request.isPending}>
              {t('analysis.exports.request')}
            </Button>
            <p role="status" aria-live="polite">
              {message}
            </p>
          </div>
          <ErrorText>{error}</ErrorText>
          <p className="text-slate-600">{t('analysis.exports.audited')}</p>
        </form>
      </Card>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('analysis.exports.list')}</h2>
        {list.data?.length ? (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full text-sm" data-testid="exports-list">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    {t('analysis.exports.when')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('analysis.exports.format')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('analysis.exports.status')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('analysis.exports.rows')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('analysis.exports.size')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('analysis.exports.file')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((e) => (
                  <tr key={e.id} data-status={e.status}>
                    <td className="px-3 py-2">
                      {new Date(e.createdAt).toLocaleString(i18n.language, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {t(`analysis.exports.formats.${e.options.format}`)}
                    </td>
                    <td className="px-3 py-2">
                      {t(`analysis.exports.statuses.${e.status}`)}
                      {e.error ? <span className="block text-red-ink-700">{e.error}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.rows ?? '–'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{kb(e.size)}</td>
                    <td className="px-3 py-2">
                      {e.status === 'done' ? (
                        <a
                          className="font-medium text-indigo-ink-700 hover:underline"
                          href={`/api/v1/projects/${projectId}/exports/${e.id}/file`}
                          download={e.fileName ?? undefined}
                        >
                          {t('analysis.exports.download')} {e.fileName}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-600">{list.isLoading ? '…' : t('analysis.exports.none')}</p>
        )}
      </section>
    </div>
  );
}
