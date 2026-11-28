import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, PageHeader } from '../routes/ui.js';
import { AUDIT_ACTIONS, AUDIT_PRESETS, type AuditPreset } from './audit-actions.js';
import { actionLabel, describeDetails, type DescribeContext } from './audit-details.js';

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
const areaOf = (action: string) => action.split('.')[0]!;
const PRESETS = Object.keys(AUDIT_PRESETS) as AuditPreset[];
const chip =
  'rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50 aria-pressed:text-indigo-ink-700';

/**
 * The organisation's activity log, newest first: quick filters (corrections, exports, personal
 * data…), filters by action, person, project, case and dates, pages of 50 with no cap, and each
 * entry's details in words.
 */
export function AuditPage() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  // Filters can come in the address (?actor=, ?projectId=, ?caseRef=, ?preset=), read on arrival.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const initial = (k: string) =>
    typeof search[k] === 'string' || typeof search[k] === 'number' ? String(search[k]) : '';
  const [preset, setPreset] = useState<AuditPreset | ''>(() => {
    const p = initial('preset');
    return (PRESETS as string[]).includes(p) ? (p as AuditPreset) : '';
  });
  const [action, setAction] = useState('');
  const [actor, setActor] = useState(() => initial('actor'));
  const [project, setProject] = useState(() => initial('projectId'));
  const [caseRef, setCaseRef] = useState(() => initial('caseRef'));
  const [caseDraft, setCaseDraft] = useState(caseRef);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const people = useQuery({
    queryKey: ['team', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string }[]>('/users'),
    enabled: !!me.data?.permissions.includes('users.read'),
  });
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string }[]>('/projects'),
    enabled: !!me.data,
  });
  const names = useMemo(
    () =>
      new Map(
        [...(people.data ?? []), ...(projects.data ?? [])].map((p) => [p.id.toLowerCase(), p.name]),
      ),
    [people.data, projects.data],
  );

  // The filters the list and the export share.
  const filters = new URLSearchParams();
  if (action) filters.set('action', action);
  else if (preset) filters.set('actions', AUDIT_PRESETS[preset].join(','));
  if (actor) filters.set('actorUserId', actor);
  if (project) filters.set('projectId', project);
  if (caseRef) filters.set('caseRef', caseRef);
  const params = new URLSearchParams(filters);
  params.set('limit', String(PAGE));
  // Whole days in the viewer's time zone.
  if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
  // The export takes the dates above, or the last 30 days.
  const exportParams = new URLSearchParams(filters);
  exportParams.set(
    'from',
    (from ? new Date(`${from}T00:00:00`) : new Date(Date.now() - 30 * 86_400_000)).toISOString(),
  );
  exportParams.set('to', (to ? new Date(`${to}T23:59:59.999`) : new Date()).toISOString());
  exportParams.set('format', 'csv');

  const log = useInfiniteQuery({
    queryKey: ['audit', me.data?.tenantId, params.toString()],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams(params);
      if (pageParam) {
        q.set('beforeAt', pageParam.at);
        q.set('beforeId', pageParam.id);
      }
      return api<Entry[]>(`/audit-log?${q.toString()}`);
    },
    initialPageParam: null as { at: string; id: string } | null,
    // A full page may have more behind it: the next starts after its last entry.
    getNextPageParam: (last) =>
      last.length === PAGE
        ? { at: last[last.length - 1]!.at, id: last[last.length - 1]!.id }
        : null,
    enabled: !!me.data,
  });
  const entries = useMemo(() => log.data?.pages.flat() ?? [], [log.data]);

  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of AUDIT_ACTIONS) m.set(areaOf(a), [...(m.get(areaOf(a)) ?? []), a]);
    return [...m];
  }, []);
  const area = (a: string) => t(`admin.log.areas.${areaOf(a)}`, { defaultValue: areaOf(a) });
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const ctx: DescribeContext = {
    t: (k, o) => t(k, o ?? {}),
    name: (id) => names.get(id),
    date: (d) => when.format(d),
  };
  const who = (e: Entry) =>
    e.actorUserId
      ? (names.get(e.actorUserId.toLowerCase()) ?? e.actorUserId.slice(0, 8))
      : t('admin.log.system');
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const filtered = !!(preset || action || actor || project || caseRef || from || to);
  const clear = () => {
    setPreset('');
    setAction('');
    setActor('');
    setProject('');
    setCaseRef('');
    setCaseDraft('');
    setFrom('');
    setTo('');
  };

  /** What the entry is about, as a link to it when there is a page for it. */
  const target = (e: Entry): ReactNode => {
    if (!e.targetType) return null;
    const kind = t(`admin.log.targets.${e.targetType}`, { defaultValue: e.targetType });
    const d = e.details ?? {};
    const id = e.targetId ?? '';
    const named =
      names.get(id.toLowerCase()) ??
      (typeof d.externalId === 'string' ? d.externalId : null) ??
      (typeof d.name === 'string' ? d.name : null) ??
      (e.targetType === 'tenant' ? '' : id.slice(0, 8));
    const projectId = typeof d.projectId === 'string' ? d.projectId.toLowerCase() : null;
    const link =
      e.targetType === 'project' && id ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: id.toLowerCase() }}
          className="text-indigo-ink-600 underline"
        >
          {named}
        </Link>
      ) : e.targetType === 'interview' && id && projectId ? (
        <Link
          to="/projects/$projectId/review/$interviewId"
          params={{ projectId, interviewId: id.toLowerCase() }}
          className="text-indigo-ink-600 underline"
        >
          {named}
        </Link>
      ) : (
        named
      );
    return (
      <>
        <span className="text-slate-500">{kind}</span> {link}
        {projectId && e.targetType !== 'project' && names.get(projectId) ? (
          <span className="block">
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              className="text-indigo-ink-600 underline"
            >
              {names.get(projectId)}
            </Link>
          </span>
        ) : null}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.audit')} />
      <p className="max-w-3xl text-slate-600">{t('admin.log.intro')}</p>
      <Card className="flex flex-col gap-4">
        <div
          role="group"
          aria-labelledby="audit-presets"
          className="flex flex-wrap items-center gap-2"
          data-testid="audit-presets"
        >
          <span id="audit-presets" className="text-sm font-medium text-slate-700">
            {t('admin.log.presetsLabel')}
          </span>
          <button
            type="button"
            className={chip}
            aria-pressed={!preset && !action}
            onClick={() => {
              setPreset('');
              setAction('');
            }}
          >
            {t('admin.log.presets.all')}
          </button>
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={chip}
              aria-pressed={preset === p && !action}
              data-preset={p}
              onClick={() => {
                setPreset(p);
                setAction('');
              }}
            >
              {t(`admin.log.presets.${p}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 sm:min-w-[14rem] flex-col gap-1 text-sm font-medium text-slate-700">
            {t('admin.log.action')}
            <select
              className={inputCls}
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                if (e.target.value) setPreset('');
              }}
            >
              <option value="">{t('admin.log.anyAction')}</option>
              {groups.map(([g, actions]) => (
                <optgroup key={g} label={t(`admin.log.areas.${g}`, { defaultValue: g })}>
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {actionLabel(t, a)}
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
          {projects.data?.length ? (
            <label className="flex min-w-0 sm:min-w-[12rem] flex-col gap-1 text-sm font-medium text-slate-700">
              {t('admin.log.project')}
              <select
                className={inputCls}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">{t('admin.log.anyProject')}</option>
                {projects.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setCaseRef(caseDraft.trim());
            }}
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              {t('admin.log.caseRef')}
              <input
                className={`${inputCls} sm:w-40`}
                value={caseDraft}
                maxLength={128}
                aria-describedby="audit-case-hint"
                onChange={(e) => setCaseDraft(e.target.value)}
                onBlur={() => setCaseRef(caseDraft.trim())}
              />
            </label>

            <Button type="submit" variant="secondary" size="sm" className="mb-1">
              {t('admin.log.apply')}
            </Button>
          </form>
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
          {filtered ? (
            <button type="button" className={`${smallBtn} mb-1`} onClick={clear}>
              {t('admin.log.clear')}
            </button>
          ) : null}
        </div>
        <p id="audit-case-hint" className="-mt-2 text-xs text-slate-600">
          {t('admin.log.caseRefHint')}
        </p>
        {me.data?.permissions.includes('audit.export') ? (
          <div className="flex flex-wrap items-center gap-3">
            <a
              className={smallBtn}
              data-testid="audit-export"
              href={`/api/v1/audit-log/export?${exportParams.toString()}`}
            >
              {t('admin.log.export')}
            </a>
            <span className="text-xs text-slate-600">{t('admin.log.exportHint')}</span>
          </div>
        ) : null}
        {log.data ? (
          <p className="text-xs text-slate-600" role="status">
            {entries.length ? t('admin.log.shown', { count: entries.length }) : t('admin.log.none')}
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
              {entries.map((e) => {
                const rows = describeDetails(e.action, e.details, ctx);
                const isOpen = open.has(e.id);
                const panel = `audit-detail-${e.id}`;
                return (
                  <Fragment key={e.id}>
                    <tr
                      data-action={e.action}
                      className={`align-top ${isOpen ? '' : 'border-b border-slate-100'}`}
                    >
                      <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-slate-700">
                        {when.format(new Date(e.at))}
                      </td>
                      <td className="py-2 pr-4">{who(e)}</td>
                      <td className="py-2 pr-4">
                        <span className="block font-medium text-slate-800">
                          {actionLabel(t, e.action)}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                            {area(e.action)}
                          </span>
                          <code>{e.action}</code>
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-slate-600">{target(e)}</td>
                      <td className="max-w-md py-2 text-xs text-slate-600">
                        {rows.length ? (
                          <>
                            <span className="line-clamp-2">
                              {rows
                                .slice(0, 2)
                                .map((r) => `${r.label}: ${r.value}`)
                                .join(' · ')}
                            </span>
                            <button
                              type="button"
                              className="mt-1 text-xs font-semibold text-indigo-ink-600 underline"
                              aria-expanded={isOpen}
                              aria-controls={panel}
                              aria-label={
                                isOpen
                                  ? t('admin.log.hideDetails')
                                  : t('admin.log.viewDetailsOf', {
                                      action: actionLabel(t, e.action),
                                      who: who(e),
                                    })
                              }
                              onClick={() => toggle(e.id)}
                            >
                              {isOpen ? t('admin.log.hideDetails') : t('admin.log.viewDetails')}
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-slate-100" data-detail-of={e.id}>
                        <td colSpan={5} className="pb-3">
                          <div
                            id={panel}
                            className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                          >
                            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(8rem,max-content)_1fr]">
                              {rows.map((r, i) => (
                                <Fragment key={i}>
                                  <dt className="font-medium text-slate-700">{r.label}</dt>
                                  <dd className="break-words text-slate-800">{r.value}</dd>
                                </Fragment>
                              ))}
                            </dl>
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs font-semibold text-slate-600">
                                {t('admin.log.rawJson')}
                              </summary>
                              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-xs text-slate-700">
                                {JSON.stringify(e.details, null, 2)}
                              </pre>
                            </details>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {log.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {t('admin.log.more')}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
