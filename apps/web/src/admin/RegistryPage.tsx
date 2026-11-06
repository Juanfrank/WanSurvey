import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, upload } from '../api.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, QueryState } from '../routes/ui.js';
import { parseTable, pick } from './registry-csv.js';

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

/**
 * The people registry (ADR 0002): the no-contact list, what the registry knows of one phone or
 * e-mail, and the loads of the list and of the history.
 */
export function RegistryPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = !!me.data?.permissions.includes('registry.manage');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'active' | 'lifted' | 'all'>('active');
  const list = useQuery({
    queryKey: ['registry-no-contact', me.data?.tenantId, q, status],
    queryFn: () =>
      api<{ rows: Entry[]; total: number }>(
        `/registry/no-contact?status=${status}&limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    enabled: !!me.data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['registry-no-contact'] });
  const when = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);
  const channelsText = (c: string[] | null) => (c ? c.join(', ') : t('admin.registry.allChannels'));

  // Add one
  const [value, setValue] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('do_not_contact');
  const [channels, setChannels] = useState<string[]>([]);
  const [days, setDays] = useState('');
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
      setValue('');
      await refresh();
    },
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

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('admin.registry.title')}</h1>
      <p className="-mt-3 max-w-3xl text-slate-600">{t('admin.registry.intro')}</p>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t('admin.registry.lookup')}</h2>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (look.trim()) found.mutate();
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('admin.registry.value')}</span>
                <input
                  className={`${inputCls} w-64`}
                  value={look}
                  onChange={(e) => setLook(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{t('admin.registry.countryCode')}</span>
                <input
                  className={`${inputCls} w-20`}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="51"
                  value={cc}
                  onChange={(e) => setCc(e.target.value.replace(/\D/g, ''))}
                />
              </label>
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
        </Card>

        {canManage ? (
          <Card>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (value.trim()) add.mutate();
              }}
            >
              <h2 className="text-lg font-semibold">{t('admin.registry.addTitle')}</h2>
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('admin.registry.value')}</span>
                  <input
                    className={`${inputCls} w-64`}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('admin.registry.reason')}</span>
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
                  <span>{t('admin.registry.days')}</span>
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
                <legend className="mb-1">{t('admin.registry.channelsHelp')}</legend>
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
              <div>
                <Button type="submit" disabled={!value.trim() || add.isPending}>
                  {t('admin.registry.add')}
                </Button>
              </div>
            </form>
          </Card>
        ) : null}
      </div>

      {canManage ? (
        <Card>
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t('admin.registry.loadsTitle')}</h2>
            <p className="max-w-3xl text-sm text-slate-600">{t('admin.registry.loadsHelp')}</p>
            <div className="flex flex-wrap gap-6 text-sm">
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
            </div>
            <p role="status" className="text-sm empty:hidden">
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
              <p className="text-sm text-slate-600">
                {t('admin.registry.rejectedRows')}{' '}
                {result.r.examples
                  .map((e) => `${e.row} (${t(`admin.registry.why.${e.why}`)})`)
                  .join(', ')}
              </p>
            ) : null}
            {loadError ? <ErrorText>{t('admin.registry.loadError')}</ErrorText> : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('admin.registry.listTitle')}</h2>
            <div className="flex flex-wrap items-end gap-3 text-sm">
              <label className="flex flex-col gap-1">
                <span>{t('admin.registry.filter')}</span>
                <input
                  className={`${inputCls} w-48`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>{t('admin.registry.status')}</span>
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
            </div>
          </div>
          <QueryState query={list}>{null}</QueryState>
          {list.data ? (
            list.data.rows.length ? (
              <>
                <p className="text-sm text-slate-600">
                  {t('admin.registry.total', { count: list.data.total })}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="py-1 pr-3">{t('admin.registry.value')}</th>
                        <th className="py-1 pr-3">{t('admin.registry.reason')}</th>
                        <th className="py-1 pr-3">{t('admin.registry.channels')}</th>
                        <th className="py-1 pr-3">{t('admin.registry.validity')}</th>
                        <th className="py-1 pr-3">{t('admin.registry.origin')}</th>
                        <th className="py-1">
                          <span className="sr-only">{t('admin.registry.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.rows.map((n: Entry) => (
                        <tr key={n.id} className="border-b border-slate-100">
                          <td className="py-1 pr-3 font-mono">{n.value}</td>
                          <td className="py-1 pr-3">{t(`admin.registry.reasons.${n.reason}`)}</td>
                          <td className="py-1 pr-3">{channelsText(n.channels)}</td>
                          <td className="py-1 pr-3">
                            {n.liftedAt
                              ? t('admin.registry.liftedOn', { date: when(n.liftedAt) })
                              : n.expiresAt
                                ? t('admin.registry.until', { date: when(n.expiresAt) })
                                : t('admin.registry.permanent')}
                          </td>
                          <td className="py-1 pr-3">{t(`admin.registry.sources.${n.source}`)}</td>
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
                </div>
              </>
            ) : (
              <p className="text-slate-600">{t('admin.registry.empty')}</p>
            )
          ) : null}
        </div>
      </Card>
    </div>
  );
}
