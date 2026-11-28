import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { controlCls } from '../designer/fields.js';
import { localiseError, useNote } from '../i18n-messages.js';
import { Button, Drawer, ErrorText, MoreMenu, TableScroll, type MenuEntry } from '../routes/ui.js';
import { DataFilterFields, type DataFilters } from './ResultsTab.js';
import { fileSize } from '../format.js';
import { useCan } from '../designer/hooks.js';

const FORMATS = ['csv', 'xlsx', 'sav', 'dta', 'codebook', 'sql'] as const;

/** What an export was asked for: kept with it, shown in the list and used to repeat it. */
interface ExportOptions {
  format: (typeof FORMATS)[number];
  labels?: 'codes' | 'labels';
  rosters?: 'wide' | 'long';
  paradata?: boolean;
  approvedOnly?: boolean;
  /** CSV: the codebook alongside, in a ZIP. */
  codebook?: boolean;
  personalData?: 'include' | 'exclude';
  questionnaireId?: string;
  mode?: string;
  from?: string;
  to?: string;
  language?: string;
}

interface ExportRow {
  id: string;
  options: ExportOptions;
  /** Holds personal answers: downloaded only with `pii.view`. */
  personal: boolean;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  fileName: string | null;
  size: number | null;
  rows: number | null;
  error: string | null;
  createdAt: string;
  /** When the file is deleted (null: kept, or not built). */
  availableUntil?: string | null;
  downloads?: { count: number; last: { at: string; by: string | null } | null };
}

const kb = (n: number | null) => (n === null ? '–' : fileSize(n));

/** The file's kind on its download button: "CSV", "SAV", "ZIP"… */
const kind = (e: ExportRow) => {
  const ext = e.fileName?.includes('.') ? e.fileName.split('.').pop()! : e.options.format;
  return ext.toUpperCase().slice(0, 5);
};

const TAG = 'whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800';

/** Data exports (M6): request a file, watch it being built, download it. */
export function ExportsTab({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const pii = useCan('pii.view', projectId);
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('csv');
  const [labels, setLabels] = useState<'codes' | 'labels'>('codes');
  const [rosters, setRosters] = useState<'wide' | 'long'>('wide');
  const [paradata, setParadata] = useState(false);
  const [withBook, setWithBook] = useState(false);
  // Personal answers stay out of the file unless chosen (data minimisation).
  const [personalData, setPersonalData] = useState<'include' | 'exclude'>('exclude');
  const [filters, setFilters] = useState<DataFilters>({});
  const [message, setMessage] = useNote();
  const [error, setError] = useState<string | null>(null);
  // The form opens in a side panel; the list keeps the page.
  const [creating, setCreating] = useState(false);
  const formId = useId();
  const list = useQuery({
    queryKey: ['exports', projectId],
    queryFn: () => api<ExportRow[]>(`/projects/${projectId}/exports`),
    // Exports being built are checked every second and a half until they are ready.
    refetchInterval: (q) =>
      q.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 1500 : false,
  });
  const versions = useQuery({
    queryKey: ['data-questionnaires', projectId],
    queryFn: () =>
      api<{ id: string; name: string; version: number }[]>(
        `/projects/${projectId}/data/questionnaires`,
      ),
  });
  const request = useMutation({
    mutationFn: (body: ExportOptions) =>
      api(`/projects/${projectId}/exports`, { method: 'POST', body }),
    onSuccess: async () => {
      setError(null);
      setCreating(false);
      setMessage({ key: 'analysis.exports.requested' });
      await qc.invalidateQueries({ queryKey: ['exports', projectId] });
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  const dateOnly = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' });
  /** The options of an export in words: enough to tell two files apart and to reproduce one. */
  const params = (o: ExportOptions) => {
    const v = versions.data?.find((q) => q.id === o.questionnaireId);
    const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(i18n.language);
    return [
      v ? v.name : null,
      o.format === 'csv' || o.format === 'xlsx' || o.format === 'sql'
        ? t(`analysis.exports.labelOptions.${o.labels ?? 'codes'}`)
        : null,
      o.rosters === 'long' ? t('analysis.exports.rosterOptions.long') : null,
      o.paradata ? t('analysis.exports.withParadata') : null,
      // All the completes is the default: only the narrower choice is shown.
      o.approvedOnly ? t('analysis.exports.onlyApproved') : null,
      o.mode ? t(`analysis.modes.${o.mode}`, { defaultValue: o.mode }) : null,
      o.from || o.to
        ? t('analysis.exports.dates', {
            from: o.from ? day(o.from) : '…',
            to: o.to ? day(o.to) : '…',
          })
        : null,
      o.language ? o.language : null,
      o.personalData === 'exclude' ? t('analysis.exports.noPersonal') : null,
      o.format === 'xlsx' || o.format === 'sav' || o.format === 'dta'
        ? t('analysis.exports.withCodebook')
        : o.format === 'csv' && o.codebook
          ? t('analysis.exports.withCodebookZip')
          : null,
    ].filter((x): x is string => !!x);
  };
  const repeat = (e: ExportRow) =>
    request.mutate({
      ...e.options,
      // Older exports did not say: keep what the file had.
      personalData: e.options.personalData ?? (e.personal ? 'include' : 'exclude'),
    });
  const fileUrl = (e: ExportRow) => `/api/v1/projects/${projectId}/exports/${e.id}/file`;
  const canDownload = (e: ExportRow) => e.status === 'done' && !(e.personal && !pii);
  /** The row's other actions: export again with the same options, copy the file's address. */
  const entries = (e: ExportRow): MenuEntry[] => [
    ...(e.status === 'done' || e.status === 'failed' || e.status === 'expired'
      ? [
          {
            type: 'item' as const,
            id: 'repeat',
            label: t('analysis.exports.repeat'),
            disabled: request.isPending,
            onSelect: () => repeat(e),
          },
        ]
      : []),
    ...(canDownload(e)
      ? [
          {
            type: 'item' as const,
            id: 'copy',
            label: t('analysis.exports.copyLink'),
            onSelect: () => {
              const url = new URL(fileUrl(e), window.location.href).toString();
              // Copying refused or impossible (plain http): the address is shown to copy by hand.
              if (!navigator.clipboard) return setMessage({ text: url });
              navigator.clipboard.writeText(url).then(
                () => setMessage({ key: 'analysis.exports.copied' }),
                () => setMessage({ text: url }),
              );
            },
          },
        ]
      : []),
  ];
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

  const form = (
    <form
      id={formId}
      className="flex flex-col gap-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        request.mutate({
          format,
          labels,
          rosters,
          paradata,
          ...(format === 'csv' && withBook ? { codebook: true } : {}),
          personalData: pii ? personalData : 'exclude',
          approvedOnly: !!filters.approvedOnly,
          ...(filters.questionnaireId ? { questionnaireId: filters.questionnaireId } : {}),
          ...(filters.mode ? { mode: filters.mode } : {}),
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
        });
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
      {format === 'sql' ? (
        <p className="max-w-3xl text-slate-600">{t('analysis.exports.sqlHint')}</p>
      ) : null}
      {format === 'csv' || format === 'xlsx' || format === 'sql' ? (
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
      {format === 'csv' ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={withBook}
            onChange={(e) => setWithBook(e.target.checked)}
          />
          {t('analysis.exports.codebookZip')}
        </label>
      ) : null}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={paradata} onChange={(e) => setParadata(e.target.checked)} />
        {t('analysis.exports.paradata')}
      </label>
      {pii ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1">{t('analysis.exports.personalData')}</legend>
          {radio(
            'personalData',
            personalData,
            setPersonalData,
            ['exclude', 'include'] as const,
            (v) => t(`analysis.exports.personalOptions.${v}`),
          )}
        </fieldset>
      ) : (
        <p className="text-slate-600">{t('analysis.exports.personalLeftOut')}</p>
      )}
      <DataFilterFields projectId={projectId} value={filters} onChange={setFilters} />
      <ErrorText>{error}</ErrorText>
      <p className="text-xs text-slate-600">{t('analysis.exports.audited')}</p>
    </form>
  );

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="exports">
      {/* The printable summary (PDF) is in Results, with the links for clients. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('analysis.exports.list')}</h2>
        <p role="status" aria-live="polite" className="mr-auto text-slate-700">
          {message}
        </p>
        <Button
          type="button"
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
        >
          <span aria-hidden="true">+ </span>
          {t('analysis.exports.new')}
        </Button>
      </div>
      {/* A repeated export that fails says so here (the form's own errors show in it). */}
      {!creating ? <ErrorText>{error}</ErrorText> : null}
      {creating ? (
        <Drawer
          title={t('analysis.exports.new')}
          onClose={() => setCreating(false)}
          footer={
            <Button type="submit" form={formId} busy={request.isPending}>
              {t('analysis.exports.request')}
            </Button>
          }
        >
          {form}
        </Drawer>
      ) : null}
      <section>
        {list.data?.length ? (
          <TableScroll
            label={t('analysis.exports.list')}
            className="rounded-lg border border-slate-200 bg-white"
          >
            <table className="min-w-full text-sm" data-testid="exports-list">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th scope="col" className="px-2.5 py-2">
                    {t('analysis.exports.when')}
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    {t('analysis.exports.format')}
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    {t('analysis.exports.params')}
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    {t('analysis.exports.status')}
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    {t('analysis.exports.rows')}
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right">
                    {t('analysis.exports.size')}
                  </th>
                  <th scope="col" className="px-2.5 py-2">
                    {t('analysis.exports.file')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((e) => (
                  <tr key={e.id} data-status={e.status}>
                    <td className="whitespace-nowrap px-2.5 py-2">{when(e.createdAt)}</td>
                    <td className="whitespace-nowrap px-2.5 py-2">
                      {t(`analysis.exports.formats.${e.options.format}`)}
                    </td>
                    {/* One line: the first option (the questionnaire) and "+N"; the whole
                        list in its title and for screen readers. */}
                    <td
                      className="whitespace-nowrap px-2.5 py-2"
                      data-testid="export-params"
                      title={params(e.options).join(' · ')}
                    >
                      <span className="sr-only">{params(e.options).join(', ')}</span>
                      <span aria-hidden="true" className="inline-flex items-center gap-1">
                        {params(e.options)
                          .slice(0, 1)
                          .map((x) => (
                            <span key={x} className={`${TAG} max-w-[14rem] truncate`}>
                              {x}
                            </span>
                          ))}
                        {params(e.options).length > 1 ? (
                          <span className={TAG}>+{params(e.options).length - 1}</span>
                        ) : null}
                      </span>
                      {e.personal ? (
                        <span
                          className="ml-1 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-ink-900"
                          title={t('analysis.exports.personal')}
                        >
                          {t('analysis.exports.personalTag')}
                          <span className="sr-only">: {t('analysis.exports.personal')}</span>
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2">
                      {t(`analysis.exports.statuses.${e.status}`)}
                      {e.error ? (
                        <span
                          className="block max-w-[16rem] truncate text-xs text-red-ink-700"
                          title={e.error}
                        >
                          {e.error}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{e.rows ?? '–'}</td>
                    <td className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums">
                      {kb(e.size)}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2">
                      <span className="flex items-center gap-1.5">
                        {canDownload(e) ? (
                          <a
                            className="inline-flex items-center gap-1 rounded-md border border-indigo-600 bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-on-fill hover:bg-indigo-500"
                            href={fileUrl(e)}
                            download={e.fileName ?? undefined}
                            aria-label={`${t('analysis.exports.download')} ${e.fileName ?? ''}`}
                            title={e.fileName ?? undefined}
                          >
                            <span aria-hidden="true">⬇</span> {kind(e)}
                          </a>
                        ) : null}
                        <MoreMenu
                          label={t('analysis.exports.actions', { when: when(e.createdAt) })}
                          entries={entries(e)}
                          className="px-2 py-0.5"
                        />
                      </span>
                      {e.availableUntil || e.downloads?.last ? (
                        <span className="mt-0.5 block text-xs text-slate-600">
                          {e.availableUntil
                            ? t('analysis.exports.until', { date: dateOnly(e.availableUntil) })
                            : null}
                          {e.availableUntil && e.downloads?.last ? ' · ' : null}
                          {e.downloads?.last ? (
                            <span
                              data-testid="export-downloads"
                              title={t('analysis.exports.downloaded', {
                                count: e.downloads.count,
                                by: e.downloads.last.by ?? '–',
                                date: when(e.downloads.last.at),
                              })}
                            >
                              {t('analysis.exports.downloads', { count: e.downloads.count })}
                              <span className="sr-only">
                                {' '}
                                (
                                {t('analysis.exports.downloaded', {
                                  count: e.downloads.count,
                                  by: e.downloads.last.by ?? '–',
                                  date: when(e.downloads.last.at),
                                })}
                                )
                              </span>
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <p className="text-slate-600">{list.isLoading ? '…' : t('analysis.exports.none')}</p>
        )}
      </section>
    </div>
  );
}
