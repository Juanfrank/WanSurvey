import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { inputCls } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card } from '../routes/ui.js';
import { AUDIT_ACTIONS } from './audit-actions.js';

interface Entry {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  at: string;
}

const PAGE = 50;
const MAX = 500;
const areaOf = (action: string) => action.split('.')[0]!;

/** The organisation's activity log, newest first, with filters by action, person and dates. */
export function AuditPage() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const people = useQuery({
    queryKey: ['team', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string }[]>('/users'),
    enabled: !!me.data?.permissions.includes('users.read'),
  });
  const names = useMemo(
    () => new Map((people.data ?? []).map((p) => [p.id, p.name])),
    [people.data],
  );
  const params = new URLSearchParams({ limit: String(limit) });
  if (action) params.set('action', action);
  if (actor) params.set('actorUserId', actor);
  // Whole days in the viewer's time zone.
  if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
  const log = useQuery({
    queryKey: ['audit', me.data?.tenantId, params.toString()],
    queryFn: () => api<Entry[]>(`/audit-log?${params.toString()}`),
    enabled: !!me.data,
  });
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of AUDIT_ACTIONS) m.set(areaOf(a), [...(m.get(areaOf(a)) ?? []), a]);
    return [...m];
  }, []);
  const area = (a: string) => t(`admin.log.areas.${areaOf(a)}`, { defaultValue: areaOf(a) });
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('admin.audit')}</h1>
      <p className="-mt-3 max-w-3xl text-slate-600">{t('admin.log.intro')}</p>
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 sm:min-w-[14rem] flex-col gap-1 text-sm font-medium text-slate-700">
            {t('admin.log.action')}
            <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">{t('admin.log.anyAction')}</option>
              {groups.map(([g, actions]) => (
                <optgroup key={g} label={t(`admin.log.areas.${g}`, { defaultValue: g })}>
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {people.data ? (
            <label className="flex min-w-0 sm:min-w-[12rem] flex-col gap-1 text-sm font-medium text-slate-700">
              {t('admin.log.who')}
              <select className={inputCls} value={actor} onChange={(e) => setActor(e.target.value)}>
                <option value="">{t('admin.log.anyone')}</option>
                {people.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            {t('admin.log.from')}
            <input
              type="date"
              className={inputCls}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            {t('admin.log.to')}
            <input
              type="date"
              className={inputCls}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {log.data ? (
          <p className="text-xs text-slate-600" role="status">
            {log.data.length
              ? t('admin.log.shown', { count: log.data.length })
              : t('admin.log.none')}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" aria-busy={log.isLoading}>
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-semibold">{t('admin.log.when')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.log.who')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.log.what')}</th>
                <th className="py-2 pr-4 font-semibold">{t('admin.log.target')}</th>
                <th className="py-2 font-semibold">{t('admin.log.details')}</th>
              </tr>
            </thead>
            <tbody>
              {(log.data ?? []).map((e) => (
                <tr
                  key={e.id}
                  data-action={e.action}
                  className="border-b border-slate-100 align-top"
                >
                  <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-slate-700">
                    {when.format(new Date(e.at))}
                  </td>
                  <td className="py-2 pr-4">
                    {e.actorUserId
                      ? (names.get(e.actorUserId) ?? e.actorUserId.slice(0, 8))
                      : t('admin.log.system')}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="mr-2 whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {area(e.action)}
                    </span>
                    <code className="text-xs">{e.action}</code>
                  </td>
                  <td className="py-2 pr-4 text-xs text-slate-600">
                    {e.targetType ? `${e.targetType} ` : ''}
                    {e.targetId ? (names.get(e.targetId) ?? e.targetId.slice(0, 8)) : ''}
                  </td>
                  <td className="max-w-md py-2 text-xs text-slate-600">
                    <span className="line-clamp-2 break-all font-mono">
                      {Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {log.data && log.data.length === limit && limit < MAX ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE)}>
              {t('admin.log.more')}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
