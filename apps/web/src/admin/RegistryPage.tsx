import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, upload } from '../api.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { InfoTip } from '../cases/samplingControls.js';
import {
  Button,
  Card,
  Drawer,
  ErrorText,
  FilterBar,
  MoreMenu,
  QueryState,
  PageHeader,
  TableScroll,
} from '../routes/ui.js';
import { parseTable, pick } from './registry-csv.js';
import { locale } from '../format.js';

const REASONS = ['do_not_contact', 'not_interested', 'complaint', 'deceased', 'other'] as const;
const CHANNELS = ['CATI', 'CAPI', 'CAWI', 'PAPI'] as const;

interface Entry {
  id: string;
  kind: 'phone' | 'email';
  value: string;
  channels: string[] | null;
  reason: string;
  source: string;
  note: string | null;
  expiresAt: string | null;
  createdAt: string;
  liftedAt: string | null;
}
interface Participation {
  channel: string;
  occurredAt: string;
  result: string | null;
  projectName: string | null;
  source: string;
}
interface LoadResult {
  added?: number;
  updated?: number;
  loaded?: number;
  rejected: number;
  examples: { row: number; why: string }[];
}

const CHUNK = 1000;
/** Entries per page of the no-contact list. */
const PAGE = 20;

/**
 * The people registry (ADR 0002): the no-contact list, what the registry knows of one phone or
 * e-mail, and the loads of the list and of the history. The list fills the page; looking up,
 * adding and loading files open in side panels.
 */
export function RegistryPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = !!me.data?.permissions.includes('registry.manage');
  const [q, setQ0] = useState('');
  const [status, setStatus0] = useState<'active' | 'lifted' | 'all'>('active');
  const [page, setPage] = useState(0);
  // Another search or filter starts again from the first page.
  const setQ = (v: string) => {
    setQ0(v);
    setPage(0);
  };
  const setStatus = (v: typeof status) => {
    setStatus0(v);
    setPage(0);
  };
  const [panel, setPanel] = useState<'lookup' | 'add' | 'loads' | null>(null);
  const addForm = useId();
  const list = useQuery({
    queryKey: ['registry-no-contact', me.data?.tenantId, q, status, page],
    queryFn: () =>
      api<{ rows: Entry[]; total: number }>(
        `/registry/no-contact?status=${status}&limit=${PAGE}&offset=${page * PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    enabled: !!me.data,
    // The table and its pages stay while the next page loads (the focus stays on "Next").
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['registry-no-contact'] });
  const when = (iso: string) => new Date(iso).toLocaleDateString(locale(i18n.language));
  const channelsText = (c: string[] | null) => (c ? c.join(', ') : t('admin.registry.allChannels'));

  // Add one
  const [value, setValue] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('do_not_contact');
  const [channels, setChannels] = useState<string[]>([]);
  const [days, setDays] = useState('');
  // The value just added, said in the panel (which stays open for the next one).
  const [added, setAdded] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api('/registry/no-contact', {
        method: 'POST',
        body: {
          value: value.trim(),
          reason,
          channels: channels.length ? channels : null,
          days: days.trim() ? Number(days) : null,
          defaultCountryCode: cc.trim() || undefined,
        },
      }),
    onSuccess: async () => {
      setAdded(value.trim());
      setValue('');
      await refresh();
    },
    onError: () => setAdded(null),
  });
  const lift = useMutation({
    mutationFn: (id: string) => api(`/registry/no-contact/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  // Country code for national numbers in typed values and in files
  const [cc, setCc] = useState('');

  // Look up
  const [look, setLook] = useState('');
  const found = useMutation({
    mutationFn: () =>
      api<{ kind: string; value: string; noContact: Entry[]; participations: Participation[] }>(
        `/registry/lookup?value=${encodeURIComponent(look.trim())}${cc.trim() ? `&cc=${cc.trim()}` : ''}`,
      ),
  });

  // Loads
  const [result, setResult] = useState<{ kind: 'list' | 'history'; r: LoadResult } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const load = useMutation({
    mutationFn: async ({ kind, file }: { kind: 'list' | 'history'; file: File }) => {
      let table: Record<string, string>[];
      if (/\.xlsx$/i.test(file.name)) {
        // A spreadsheet is read by the server, which also knows its dates.
        const form = new FormData();
        form.append('file', file);
        table = (await upload<{ rows: Record<string, string>[] }>('/registry/read-file', form))
          .rows;
      } else table = parseTable(await file.text());
      const total: LoadResult = { added: 0, updated: 0, loaded: 0, rejected: 0, examples: [] };
      const rows = table.map((r) =>
        kind === 'list'
          ? {
              value: pick(r, [
                'value',
                'valor',
                'telefono',
                'teléfono',
                'phone',
                'email',
                'correo',
                'contacto',
              ]),
              reason: pick(r, ['reason', 'motivo']),
              channels: pick(r, ['channels', 'canales', 'canal']),
              until: pick(r, ['until', 'hasta', 'vence', 'vencimiento']),
              note: pick(r, ['note', 'nota', 'observacion', 'observación']),
            }
          : {
              value: pick(r, [
                'value',
                'valor',
                'telefono',
                'teléfono',
                'phone',
                'email',
                'correo',
                'contacto',
              ]),
              channel: pick(r, ['channel', 'canal', 'modo']),
              date: pick(r, ['date', 'fecha']),
              result: pick(r, ['result', 'resultado']),
              project: pick(r, ['project', 'proyecto', 'estudio']),
            },
      );
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows
          .slice(i, i + CHUNK)
          .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
        const r = await api<LoadResult>(
          kind === 'list' ? '/registry/no-contact/import' : '/registry/participations/import',
          { method: 'POST', body: { rows: part, defaultCountryCode: cc.trim() || undefined } },
        );
        total.added! += r.added ?? 0;
        total.updated! += r.updated ?? 0;
        total.loaded! += r.loaded ?? 0;
        total.rejected += r.rejected;
        for (const e of r.examples)
          if (total.examples.length < 20) total.examples.push({ ...e, row: e.row + i });
      }
      return { kind, r: total };
    },
    onSuccess: async (r) => {
      setLoadError(false);
      setResult(r);
      await refresh();
    },
    onError: () => setLoadError(true),
  });
  const onFile = (kind: 'list' | 'history') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) load.mutate({ kind, file });
  };

  const ccField = (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{t('admin.registry.countryCode')}</span>
      <input
        className={`${inputCls} w-20`}
        inputMode="numeric"
        maxLength={4}
        placeholder="51"
        value={cc}
        onChange={(e) => setCc(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );
  const total = list.data?.total ?? 0;
  const first = page * PAGE;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.registry.title')}
        aside={
          <InfoTip
            id="registry-intro"
            term={t('admin.registry.title')}
            text={t('admin.registry.intro')}
            align="start"
          />
        }
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                found.reset();
                setPanel('lookup');
              }}
            >
              {t('admin.registry.lookupOpen')}
            </Button>
            {canManage ? (
              <Button
                onClick={() => {
                  setAdded(null);
                  setPanel('add');
                }}
              >
                {t('admin.registry.addOpen')}
              </Button>
            ) : null}
          </>
        }
      />

      <Card className="flex flex-col gap-3 p-4!">
        <h2 className="sr-only">{t('admin.registry.listTitle')}</h2>
        <FilterBar
          search={{ value: q, onChange: setQ, label: t('admin.registry.filter') }}
          active={
            status === 'active'
              ? []
              : [
                  {
                    id: 'status',
                    label: t('admin.registry.status'),
                    value: t(`admin.registry.statuses.${status}`),
                    onRemove: () => setStatus('active'),
                  },
                ]
          }
          count={list.data ? t('admin.registry.total', { count: total }) : undefined}
          actions={
            canManage ? (
              <MoreMenu
                label={t('admin.registry.moreTools')}
                entries={[
                  {
                    type: 'item',
                    id: 'loads',
                    label: t('admin.registry.loadsOpen'),
                    onSelect: () => {
                      setResult(null);
                      setLoadError(false);
                      setPanel('loads');
                    },
                  },
                ]}
              >
                <span aria-hidden="true">⋯</span> {t('ui.more')}
              </MoreMenu>
            ) : null
          }
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('admin.registry.status')}</span>
            <select
              className={`${inputCls} py-2`}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              {(['active', 'lifted', 'all'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`admin.registry.statuses.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </FilterBar>
        <QueryState query={list}>{null}</QueryState>
        {list.data ? (
          list.data.rows.length ? (
            <>
              <TableScroll label={t('admin.registry.listTitle')}>
                <table className="w-full text-left text-sm [&_td]:whitespace-nowrap">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">{t('admin.registry.value')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('admin.registry.reason')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('admin.registry.channels')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('admin.registry.validity')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('admin.registry.origin')}</th>
                      <th className="py-2">
                        <span className="sr-only">{t('admin.registry.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.rows.map((n: Entry) => (
                      <tr key={n.id} className="border-b border-slate-100">
                        <td className="py-1.5 pr-4 font-mono">{n.value}</td>
                        <td className="py-1.5 pr-4">{t(`admin.registry.reasons.${n.reason}`)}</td>
                        <td className="py-1.5 pr-4">{channelsText(n.channels)}</td>
                        <td className="py-1.5 pr-4">
                          {n.liftedAt
                            ? t('admin.registry.liftedOn', { date: when(n.liftedAt) })
                            : n.expiresAt
                              ? t('admin.registry.until', { date: when(n.expiresAt) })
                              : t('admin.registry.permanent')}
                        </td>
                        <td className="py-1.5 pr-4">{t(`admin.registry.sources.${n.source}`)}</td>
                        <td className="py-1 text-right">
                          {canManage && !n.liftedAt ? (
                            <button
                              type="button"
                              className={smallBtn}
                              onClick={() => lift.mutate(n.id)}
                            >
                              {t('admin.registry.lift')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </>
          ) : (
            <p className="text-slate-600">{t('admin.registry.empty')}</p>
          )
        ) : null}
        {list.data && (total > PAGE || page > 0) ? (
          <nav
            aria-label={t('admin.registry.pages')}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <button
              type="button"
              className={smallBtn}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              {t('admin.registry.prev')}
            </button>
            <span className="text-slate-700">
              {t('admin.registry.range', {
                from: first + 1,
                to: Math.min(first + PAGE, total),
                total,
              })}
            </span>
            <button
              type="button"
              className={smallBtn}
              disabled={first + PAGE >= total}
              onClick={() => setPage(page + 1)}
            >
              {t('admin.registry.next')}
            </button>
          </nav>
        ) : null}
      </Card>

      {panel === 'lookup' ? (
        <Drawer title={t('admin.registry.lookup')} onClose={() => setPanel(null)}>
          <div className="flex flex-col gap-3">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (look.trim()) found.mutate();
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">{t('admin.registry.value')}</span>
                <input
                  className={`${inputCls} w-60`}
                  value={look}
                  onChange={(e) => setLook(e.target.value)}
                />
              </label>
              {ccField}
              <Button type="submit" disabled={!look.trim() || found.isPending}>
                {t('admin.registry.search')}
              </Button>
            </form>
            {found.isError ? <ErrorText>{t('admin.registry.badValue')}</ErrorText> : null}
            {found.data ? (
              <div className="flex flex-col gap-2 text-sm" data-testid="registry-lookup">
                <p className="font-medium">{found.data.value}</p>
                <p>
                  {found.data.noContact.length
                    ? found.data.noContact
                        .map(
                          (n) =>
                            `${t(`admin.registry.reasons.${n.reason}`)} · ${channelsText(n.channels)} · ${
                              n.liftedAt
                                ? t('admin.registry.liftedOn', { date: when(n.liftedAt) })
                                : n.expiresAt
                                  ? t('admin.registry.until', { date: when(n.expiresAt) })
                                  : t('admin.registry.permanent')
                            }`,
                        )
                        .join(' / ')
                    : t('admin.registry.notOnList')}
                </p>
                {found.data.participations.length ? (
                  <ul className="list-disc pl-5">
                    {found.data.participations.map((p, i) => (
                      <li key={i}>
                        {when(p.occurredAt)} · {p.channel}
                        {p.projectName ? ` · ${p.projectName}` : ''}
                        {p.result ? ` · ${p.result}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-600">{t('admin.registry.noParticipations')}</p>
                )}
              </div>
            ) : null}
          </div>
        </Drawer>
      ) : null}

      {panel === 'add' && canManage ? (
        <Drawer
          title={t('admin.registry.addTitle')}
          onClose={() => setPanel(null)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setPanel(null)}>
                {t('admin.registry.close')}
              </Button>
              <Button type="submit" form={addForm} disabled={!value.trim() || add.isPending}>
                {t('admin.registry.add')}
              </Button>
            </>
          }
        >
          <form
            id={addForm}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) add.mutate();
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">{t('admin.registry.value')}</span>
                <input
                  className={`${inputCls} w-60`}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setAdded(null);
                  }}
                />
              </label>
              {ccField}
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">{t('admin.registry.reason')}</span>
                <select
                  className={`${inputCls} py-2`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
                >
                  {REASONS.map((r) => (
                    <option key={r} value={r}>
                      {t(`admin.registry.reasons.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">{t('admin.registry.days')}</span>
                <input
                  type="number"
                  min={1}
                  className={`${inputCls} w-28`}
                  placeholder={t('admin.registry.permanent')}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </label>
            </div>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-1 font-medium text-slate-700">
                {t('admin.registry.channelsHelp')}
              </legend>
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={channels.includes(c)}
                    onChange={(e) =>
                      setChannels(
                        e.target.checked ? [...channels, c] : channels.filter((x) => x !== c),
                      )
                    }
                  />
                  {c}
                </label>
              ))}
            </fieldset>
            {add.isError ? <ErrorText>{t('admin.registry.badValue')}</ErrorText> : null}
            <p role="status" className="text-sm text-emerald-ink-800 empty:hidden">
              {added ? t('admin.registry.added', { value: added }) : null}
            </p>
          </form>
        </Drawer>
      ) : null}

      {panel === 'loads' && canManage ? (
        <Drawer title={t('admin.registry.loadsTitle')} onClose={() => setPanel(null)}>
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-slate-600">{t('admin.registry.loadsHelp')}</p>
            {ccField}
            <div className="flex flex-col gap-1">
              <label htmlFor="registry-file-list" className="font-medium">
                {t('admin.registry.loadList')}
              </label>
              <input
                id="registry-file-list"
                type="file"
                accept=".csv,.txt,.tsv,.xlsx"
                aria-describedby="registry-file-list-cols"
                onChange={onFile('list')}
              />
              <span id="registry-file-list-cols" className="text-slate-600">
                {t('admin.registry.loadListCols')}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="registry-file-history" className="font-medium">
                {t('admin.registry.loadHistory')}
              </label>
              <input
                id="registry-file-history"
                type="file"
                accept=".csv,.txt,.tsv,.xlsx"
                aria-describedby="registry-file-history-cols"
                onChange={onFile('history')}
              />
              <span id="registry-file-history-cols" className="text-slate-600">
                {t('admin.registry.loadHistoryCols')}
              </span>
            </div>
            <p role="status" className="empty:hidden">
              {load.isPending
                ? t('admin.registry.loading')
                : result
                  ? result.kind === 'list'
                    ? t('admin.registry.listLoaded', {
                        added: result.r.added,
                        updated: result.r.updated,
                        rejected: result.r.rejected,
                      })
                    : t('admin.registry.historyLoaded', {
                        loaded: result.r.loaded,
                        rejected: result.r.rejected,
                      })
                  : null}
            </p>
            {result?.r.examples.length ? (
              <p className="text-slate-600">
                {t('admin.registry.rejectedRows')}{' '}
                {result.r.examples
                  .map((e) => `${e.row} (${t(`admin.registry.why.${e.why}`)})`)
                  .join(', ')}
              </p>
            ) : null}
            {loadError ? <ErrorText>{t('admin.registry.loadError')}</ErrorText> : null}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
