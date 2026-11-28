import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { inputCls, smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { InfoTip } from '../cases/samplingControls.js';
import {
  Button,
  Card,
  FilterBar,
  PageHeader,
  TableScroll,
  type ActiveFilter,
} from '../routes/ui.js';
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

/** Entries per step: the list grows by blocks of 20. */
const PAGE = 20;
const areaOf = (action: string) => action.split('.')[0]!;
const PRESETS = Object.keys(AUDIT_PRESETS) as AuditPreset[];
const chip =
  'rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50 aria-pressed:text-indigo-ink-700';

/**
 * The organisation's activity log, newest first: quick filters (corrections, exports, personal
 * data…), filters by action, person, project, case and dates (all in the Filters panel, those
 * that are on as chips), blocks of 20 with no cap, and each entry's details in words.
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
        {/* One line each, cut short: the project link keeps a line of its own. */}
        <span className="block truncate">
          <span className="text-slate-500">{kind}</span> {link}
        </span>
        {projectId && e.targetType !== 'project' && names.get(projectId) ? (
          <span className="block truncate">
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

  const personName = (id: string) =>
    people.data?.find((p) => p.id === id)?.name ?? names.get(id.toLowerCase()) ?? id.slice(0, 8);
  const projectLabel = (id: string) =>
    projects.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const chips: ActiveFilter[] = [
    ...(preset && !action
      ? [
          {
            id: 'preset',
            label: t('admin.log.presetsLabel'),
            value: t(`admin.log.presets.${preset}`),
            onRemove: () => setPreset(''),
          },
        ]
      : []),
    ...(action
      ? [
          {
            id: 'action',
            label: t('admin.log.action'),
            value: actionLabel(t, action),
            onRemove: () => setAction(''),
          },
        ]
      : []),
    ...(actor
      ? [
          {
            id: 'actor',
            label: t('admin.log.who'),
            value: personName(actor),
            onRemove: () => setActor(''),
          },
        ]
      : []),
    ...(project
      ? [
          {
            id: 'project',
            label: t('admin.log.project'),
            value: projectLabel(project),
            onRemove: () => setProject(''),
          },
        ]
      : []),
    ...(caseRef
      ? [
          {
            id: 'case',
            label: t('admin.log.caseRef'),
            value: caseRef,
            onRemove: () => {
              setCaseRef('');
              setCaseDraft('');
            },
          },
        ]
      : []),
    ...(from
      ? [{ id: 'from', label: t('admin.log.from'), value: from, onRemove: () => setFrom('') }]
      : []),
    ...(to ? [{ id: 'to', label: t('admin.log.to'), value: to, onRemove: () => setTo('') }] : []),
  ];
  const canExport = !!me.data?.permissions.includes('audit.export');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.audit')}
        aside={
          <InfoTip
            id="audit-intro"
            term={t('admin.audit')}
            text={t('admin.log.intro')}
            align="start"
          />
        }
      />
      <Card className="flex flex-col gap-3 p-4!">
        <FilterBar
          active={chips}
          count={
            log.data
              ? entries.length
                ? // Only what is loaded: with more behind "Show 20 more", say "the latest".
                  log.hasNextPage
                  ? t('admin.log.shown', { count: entries.length })
                  : t('admin.log.count', { count: entries.length })
                : t('admin.log.none')
              : undefined
          }
          actions={
            canExport ? (
              <a
                className={`${smallBtn} whitespace-nowrap`}
                data-testid="audit-export"
                aria-describedby="audit-export-hint"
                href={`/api/v1/audit-log/export?${exportParams.toString()}`}
              >
                {t('admin.log.export')}
              </a>
            ) : null
          }
        >
          <div
            role="group"
            aria-labelledby="audit-presets"
            className="flex basis-full flex-wrap items-center gap-2"
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
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium text-slate-700 sm:min-w-[14rem]">
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
            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium text-slate-700 sm:min-w-[12rem]">
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
            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium text-slate-700 sm:min-w-[12rem]">
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
          <p id="audit-case-hint" className="basis-full text-xs text-slate-600">
            {t('admin.log.caseRefHint')}
          </p>
        </FilterBar>
        <TableScroll label={t('admin.audit')}>
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
                      <td className="whitespace-nowrap py-1.5 pr-4 tabular-nums text-slate-700">
                        {when.format(new Date(e.at))}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-4">{who(e)}</td>
                      <td className="py-1.5 pr-4">
                        <span
                          title={actionLabel(t, e.action)}
                          className="block max-w-[15rem] truncate whitespace-nowrap font-medium text-slate-800"
                        >
                          {actionLabel(t, e.action)}
                        </span>
                        <span className="flex items-center gap-2 whitespace-nowrap text-xs text-slate-500">
                          <span className="rounded-full bg-slate-100 px-2 font-medium text-slate-700">
                            {area(e.action)}
                          </span>
                          <code>{e.action}</code>
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 text-xs text-slate-600">
                        <div className="w-[11rem]">{target(e)}</div>
                      </td>
                      <td className="py-1.5 text-xs text-slate-600">
                        {rows.length ? (
                          <>
                            <span
                              className="block w-[11rem] truncate"
                              title={rows.map((r) => `${r.label}: ${r.value}`).join(' · ')}
                            >
                              {rows
                                .slice(0, 2)
                                .map((r) => `${r.label}: ${r.value}`)
                                .join(' · ')}
                            </span>
                            <button
                              type="button"
                              className="text-xs font-semibold text-indigo-ink-600 underline"
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
        </TableScroll>
        {log.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {t('admin.log.more', { count: PAGE })}
            </Button>
          </div>
        ) : null}
        {canExport ? (
          <p id="audit-export-hint" className="text-xs text-slate-600">
            {t('admin.log.exportHint')}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
