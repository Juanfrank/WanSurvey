import './sampling-i18n.js';
import { BulkWithdraw } from './BulkWithdraw.js';
import { dangerBtn, Misidentified } from './Misidentified.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
import { ConditionBuilder } from '../designer/ConditionBuilder.js';
import { Dialog } from '../designer/Dialog.js';
import { controlCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { caseVariables } from '../designer/vars.js';
import {
  Badge,
  BulkBar,
  Button,
  FilterBar,
  MoreMenu,
  type ActiveFilter,
  type MenuEntry,
  type Tone,
} from '../routes/ui.js';
import { CaseMap } from './CaseMap.js';
import { PersonalData } from './PersonalData.js';
import { MyQuality, ReturnedToMe } from '../review/ReturnedToMe.js';
import { CallHistory, InterviewHistory, StartInterview } from './CaseInterviews.js';
import { useMe } from '../routes/AppLayout.js';
import {
  qs,
  STATUSES,
  useAssignees,
  type CaseList,
  type CaseRow,
  type CaseStatus,
} from './hooks.js';
import type { SampleField } from '../designer/vars.js';
import { FieldLabels } from './FieldLabels.js';
import { useMedia } from '../routes/SideDrawer.js';
import { dateTime } from '../format.js';
import { AssignmentsTab } from './AssignmentsTab.js';
import { DistributeDialog } from './DistributeDialog.js';
import { useQuestionnaireScope } from './scope.js';

const MAX_FIELD_COLUMNS = 4;
/**
 * The map view, column picker and rule filter come back later; their code stays. (With the rule
 * filter, "assign every matching case" would go in the list's "More" menu.)
 */
const SHOW_LATER = false as boolean;

/** When an assigned case expires, if the project sets a deadline. */
export const dueAt = (at: string, hours: number | null | undefined) =>
  hours ? new Date(Date.parse(at) + hours * 3_600_000) : null;

/** How long ago a case was assigned: under an hour, hours, then days. */
export function assignedAge(t: TFunction, at: string, now = Date.now()) {
  const hours = Math.floor((now - Date.parse(at)) / 3_600_000);
  if (hours < 1) return t('cases.list.age.lessHour');
  if (hours < 48) return t('cases.list.age.hours', { count: hours });
  return t('cases.list.age.days', { count: Math.floor(hours / 24) });
}

/**
 * The project's cases: filters, a selectable table, bulk assignment and the case drawer.
 * Interviewers and clerks get the same view limited (by the API) to their own cases.
 */
export function CasesTab({ projectId, scoped }: { projectId: string; scoped?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canAssign = useCan('cases.assign', projectId);
  const canReadAll = useCan('cases.read_all', projectId);
  const canConductHere = useCan('interviews.conduct', projectId);
  const canEditCases = useCan('cases.edit', projectId);
  // Interviewers and clerks: their own work list, what to do first at the top.
  const mine = !canReadAll;
  const canOwnMetrics = useCan('metrics.own', projectId);
  const me = useMe();
  // Phones get one card per case instead of the wide table.
  const narrow = useMedia('(max-width: 639px)');
  const [status, setStatus] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [team, setTeam] = useState('');
  const [quick, setQuick] = useState<'' | Quick>('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [cols, setCols] = useState<string[] | null>(null);
  // The open case is in the address (?case=), so a link to it can be shared. Replaced like the
  // project's tabs, which are not read back from the address on Back.
  const navigate = useNavigate();
  const open = (useSearch({ strict: false }) as { case?: string }).case ?? null;
  const setOpen = useCallback(
    (id: string | null) =>
      void navigate({
        to: '.',
        search: (s: Record<string, unknown>) => ({ ...s, case: id ?? undefined }),
        replace: true,
      }),
    [navigate],
  );
  const [assignee, setAssignee] = useState('');
  const [message, setMessage] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [how, setHow] = useState<'person' | 'rules' | 'random'>('person');
  // The cases being shared out at random: the selected ones, or [] for every free case.
  const [distributing, setDistributing] = useState<string[] | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const questionnaire = useQuestionnaireScope();
  const openCase = setOpen;
  const limit = 25;

  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [status, assignedTo, team, quick, term, filter]);

  const list = useQuery({
    queryKey: [
      'cases',
      projectId,
      questionnaire,
      status,
      assignedTo,
      team,
      quick,
      term,
      filter,
      page,
    ],
    queryFn: () =>
      api<CaseList>(
        `/projects/${projectId}/cases?${qs({ questionnaireId: questionnaire, status, assignedTo, team, quick, q: term, filter, page, limit, sort: mine ? 'todo' : undefined })}`,
      ),
    placeholderData: (prev) => prev,
  });
  const people = useAssignees(projectId, canAssign);
  // The organisation's teams of the people who work cases here, for the team filter.
  const teams = useMemo(() => {
    const byId = new Map<string, string>();
    for (const p of people.data ?? []) for (const tm of p.teams ?? []) byId.set(tm.id, tm.name);
    return [...byId]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [people.data]);
  // An interviewer's goal in force: completes so far against the target (weekly first).
  const goals = useQuery({
    queryKey: ['goals', projectId],
    queryFn: () => api<GoalRow[]>(`/projects/${projectId}/goals`),
    enabled: mine && canOwnMetrics,
  });
  const goal = myGoal(goals.data ?? [], me.data?.user.id);
  const data = list.data;
  const fields = useMemo(() => data?.fields ?? [], [data]);
  const shownNames = cols ?? fields.slice(0, MAX_FIELD_COLUMNS).map((f) => f.name);
  const shownFields = fields.filter((f) => shownNames.includes(f.name));
  const variables = useMemo(() => caseVariables(fields), [fields]);
  const pages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  const pool = data?.assignmentMode === 'pool';

  const assign = useMutation({
    mutationFn: (body: object) =>
      api<{ changed: number; skipped: number }>(`/projects/${projectId}/cases/assign`, {
        method: 'POST',
        body,
      }),
    onSuccess: async (r) => {
      setMessage(
        `${t('cases.list.assigned', { count: r.changed })}${r.skipped ? ` ${t('cases.list.skipped', { count: r.skipped })}` : ''}`,
      );
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
      await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  // The given cases (or, with none, every free one) go out by the questionnaire's rules.
  const byRules = useMutation({
    mutationFn: (caseIds: string[]) =>
      api<{ assigned: number }>(`/projects/${projectId}/assignments/apply`, {
        method: 'POST',
        body: {
          ...(caseIds.length ? { caseIds } : {}),
          ...(questionnaire ? { questionnaireId: questionnaire } : {}),
        },
      }),
    onSuccess: async (r) => {
      setMessage(t('cases.rules.applied', { count: r.assigned }));
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
      await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
      await qc.invalidateQueries({ queryKey: ['rules', projectId] });
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  const counts = data?.counts ?? {};
  const kpis = caseKpis(data, mine, pool);
  // Interviewers: only the states their cards stand for (free pool cases when they are offered).
  const totalOf: readonly CaseStatus[] = mine
    ? pool
      ? ['fresh', 'assigned', 'in_progress', 'finalised']
      : ['assigned', 'in_progress', 'finalised']
    : STATUSES;
  const kpiTotal = totalOf.reduce((a, s) => a + (counts[s] ?? 0), 0);

  const rows = data?.rows ?? [];
  const toggle = (i: number, shift: boolean) => {
    const next = new Set(selected);
    const id = rows[i]!.id;
    const on = !next.has(id);
    if (shift && lastClicked !== null) {
      const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
      for (let k = a; k <= b; k++) {
        if (on) next.add(rows[k]!.id);
        else next.delete(rows[k]!.id);
      }
    } else if (on) next.add(id);
    else next.delete(id);
    setLastClicked(i);
    setSelected(next);
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  // The filters that are on, as chips under the search.
  const assignedLabel = (v: string) =>
    v === 'none'
      ? t(canReadAll ? 'cases.list.nobody' : 'cases.list.available')
      : v === 'me'
        ? t(canReadAll ? 'cases.list.me' : 'cases.list.onlyMine')
        : (people.data?.find((p) => p.userId === v)?.name ?? v);
  const chips: ActiveFilter[] = [
    ...(status
      ? [
          {
            id: 'status',
            label: t('cases.list.status'),
            value: t(`cases.status.${status}`),
            onRemove: () => setStatus(''),
          },
        ]
      : []),
    ...(assignedTo
      ? [
          {
            id: 'assignedTo',
            label: t(canReadAll ? 'cases.list.assignedTo' : 'cases.list.show'),
            value: assignedLabel(assignedTo),
            onRemove: () => setAssignedTo(''),
          },
        ]
      : []),
    ...(team
      ? [
          {
            id: 'team',
            label: t('cases.list.team'),
            value: teams.find((tm) => tm.id === team)?.name ?? team,
            onRemove: () => setTeam(''),
          },
        ]
      : []),
    ...(quick
      ? [
          {
            id: 'quick',
            label: t('cases.list.quickChip'),
            value: t(`cases.list.quick.${quick}`),
            onRemove: () => setQuick(''),
          },
        ]
      : []),
  ];
  // Tools used now and then, behind "⋯ More".
  const tools: MenuEntry[] = [
    ...(canEditCases && fields.length
      ? [
          {
            type: 'item' as const,
            id: 'labels',
            label: t('cases.labels.title'),
            onSelect: () => setLabelsOpen(true),
          },
        ]
      : []),
    ...(canAssign
      ? [
          {
            type: 'item' as const,
            id: 'rules-all',
            label: t('cases.list.byRulesAll'),
            disabled: byRules.isPending,
            onSelect: () => byRules.mutate([]),
          },
          {
            type: 'item' as const,
            id: 'random-all',
            label: `${t('cases.list.randomAll')}…`,
            onSelect: () => setDistributing([]),
          },
        ]
      : []),
  ];

  const viewSwitch = (
    <div role="group" aria-label={t('cases.map.view')} className="flex gap-1 text-sm">
      {(['list', 'map'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          className={`${smallBtn} aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50`}
          onClick={() => setView(v)}
        >
          {t(`cases.map.${v}`)}
        </button>
      ))}
    </div>
  );
  if (view === 'map')
    return (
      <div className="flex flex-col gap-4">
        {viewSwitch}
        <CaseMap projectId={projectId} onOpen={openCase} />
        {open ? (
          <CaseDrawer
            projectId={projectId}
            caseId={open}
            fields={fields}
            onClose={() => setOpen(null)}
          />
        ) : null}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {canConductHere ? <ReturnedToMe projectId={projectId} /> : null}
      {SHOW_LATER ? viewSwitch : null}
      <section aria-labelledby="case-kpis" className="flex flex-col gap-2">
        {/* The interviewer's own quality signals, folded at the end of the title's line. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="case-kpis" className="text-sm font-semibold text-slate-700">
            {mine ? t('cases.list.kpi.mineTitle') : t('cases.list.kpi.title')} ·{' '}
            <span data-testid="kpi-total">{data ? kpiTotal : '…'}</span>
            {!mine && questionnaire && scoped ? (
              <span className="ml-2 font-normal text-slate-600">{t('cases.list.kpi.scope')}</span>
            ) : null}
          </h2>
          {canConductHere ? <MyQuality projectId={projectId} /> : null}
        </div>
        {/* One strip of pills: the name and the figure; what it counts is in the tooltip. */}
        <ul aria-label={t('cases.list.kpi.label')} className="flex flex-wrap gap-2">
          {kpis.map((k) => {
            const def = t(`cases.list.kpi.def.${k.key}`, { count: k.sub ?? 0 });
            const body = (
              <>
                <span className="text-xs font-medium text-slate-600">
                  {t(`cases.list.kpi.${k.key}`)}
                </span>
                <span className="text-lg font-bold leading-none tabular-nums" data-n="">
                  {data ? k.n : '…'}
                </span>
              </>
            );
            const pill =
              'inline-flex h-full items-baseline gap-2 whitespace-nowrap rounded-lg border bg-white px-3 py-1.5 text-left shadow-sm';
            return (
              <li key={k.key} data-kpi={k.key}>
                {k.status ? (
                  <button
                    type="button"
                    aria-pressed={status === k.status}
                    title={`${def}. ${t('cases.list.kpi.filterBy')}`}
                    className={`${pill} border-slate-200 hover:border-indigo-400 aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50`}
                    onClick={() => setStatus(status === k.status ? '' : k.status!)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={`${pill} border-slate-200`} title={def}>
                    {body}
                    {/* The tooltip is out of reach without a mouse. */}
                    <span className="sr-only">{def}</span>
                  </div>
                )}
              </li>
            );
          })}
          {goal ? (
            <li data-kpi="goal">
              <div
                title={t(`cases.list.kpi.goalState.${goal.state}`)}
                className={`inline-flex h-full items-baseline gap-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-left shadow-sm ${goal.completes >= goal.target ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}
              >
                <span className="text-xs font-medium text-slate-600">
                  {t(`cases.list.kpi.goal.${goalWindow(goal.frequency)}`)}
                </span>
                <span className="text-lg font-bold leading-none tabular-nums" data-goal="">
                  {goal.completes}
                  <span className="text-sm font-semibold text-slate-600"> / {goal.target}</span>
                </span>
                <span className="sr-only">{t(`cases.list.kpi.goalState.${goal.state}`)}</span>
              </div>
            </li>
          ) : null}
        </ul>
      </section>
      <FilterBar
        search={{ value: search, onChange: setSearch, label: t('cases.list.search') }}
        active={chips}
        actions={
          <>
            {canAssign ? (
              <button
                type="button"
                className={`${smallBtn} inline-flex h-8 items-center gap-1 whitespace-nowrap`}
                aria-label={t('cases.list.rules')}
                title={t('cases.list.rules')}
                onClick={() => setRulesOpen(true)}
              >
                <span aria-hidden="true">⚙</span>
                <span aria-hidden="true">{t('cases.list.rulesShort')}</span>
              </button>
            ) : null}
            <MoreMenu label={t('cases.list.moreTools')} entries={tools} className="h-8">
              <span aria-hidden="true">⋯</span>
              {t('ui.more')}
            </MoreMenu>
          </>
        }
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('cases.list.status')}</span>
          <select
            className={`${controlCls} w-auto`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t('cases.list.anyStatus')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`cases.status.${s}`)} ({data?.counts[s] ?? 0})
              </option>
            ))}
          </select>
        </label>
        {!canReadAll && pool ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('cases.list.show')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">{t('cases.list.mineAndAvailable')}</option>
              <option value="me">{t('cases.list.onlyMine')}</option>
              <option value="none">{t('cases.list.available')}</option>
            </select>
          </label>
        ) : null}
        {canReadAll ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('cases.list.assignedTo')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">{t('cases.list.anyone')}</option>
              <option value="none">{t('cases.list.nobody')}</option>
              <option value="me">{t('cases.list.me')}</option>
              {(people.data ?? []).map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {canReadAll && teams.length ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('cases.list.team')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={team}
              onChange={(e) => setTeam(e.target.value)}
            >
              <option value="">{t('cases.list.anyTeam')}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div
          role="group"
          aria-label={t('cases.list.quick.label')}
          className="flex flex-col gap-1 text-sm"
        >
          <span className="font-medium" aria-hidden="true">
            {t('cases.list.quick.label')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {QUICK.filter((k) => k === 'no_attempt' || data?.caseExpiryHours).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={quick === k}
                title={t(`cases.list.quick.hint.${k}`, { count: data?.caseExpiryHours ?? 0 })}
                data-quick={k}
                className={`${smallBtn} h-9 whitespace-nowrap aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50 aria-pressed:text-indigo-ink-700`}
                onClick={() => setQuick(quick === k ? '' : k)}
              >
                {t(`cases.list.quick.${k}`)}
              </button>
            ))}
          </div>
        </div>
        {SHOW_LATER && fields.length > MAX_FIELD_COLUMNS ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{t('cases.list.columns')}</summary>
            <div className="mt-1 flex flex-col gap-1 rounded-md border border-slate-200 bg-white p-2">
              {fields.map((f) => (
                <label key={f.name} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={shownNames.includes(f.name)}
                    onChange={(e) =>
                      setCols(
                        e.target.checked
                          ? [...shownNames, f.name]
                          : shownNames.filter((n) => n !== f.name),
                      )
                    }
                  />
                  {f.label ?? f.name}
                </label>
              ))}
            </div>
          </details>
        ) : null}
      </FilterBar>
      {SHOW_LATER && canReadAll && fields.length ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('cases.list.filter')}</summary>
          <div className="mt-2">
            <ConditionBuilder
              label={t('cases.list.filter')}
              hint={t('cases.list.filterHelp')}
              value={filter}
              variables={variables}
              onChange={setFilter}
            />
          </div>
        </details>
      ) : null}

      {labelsOpen ? (
        <FieldLabels projectId={projectId} fields={fields} onClose={() => setLabelsOpen(false)} />
      ) : null}

      <p role="status" aria-live="polite" className="text-sm text-slate-700 empty:hidden">
        {message}
      </p>

      {distributing ? (
        <DistributeDialog
          projectId={projectId}
          questionnaireId={questionnaire ?? null}
          caseIds={distributing}
          people={people.data ?? []}
          onClose={() => setDistributing(null)}
          onDone={(m) => {
            setDistributing(null);
            setSelected(new Set());
            setMessage(m);
          }}
        />
      ) : null}
      {rulesOpen ? (
        <Dialog title={t('cases.list.rules')} onClose={() => setRulesOpen(false)} wide>
          <AssignmentsTab projectId={projectId} />
          <div className="mt-4 flex justify-end">
            <button type="button" className={smallBtn} onClick={() => setRulesOpen(false)}>
              {t('cases.detail.close')}
            </button>
          </div>
        </Dialog>
      ) : null}

      {narrow ? (
        <ul
          className="flex flex-col gap-2"
          aria-label={`${t('cases.list.title')} · ${t('cases.list.total', { count: data?.total ?? 0 })}`}
          aria-busy={list.isFetching}
          data-testid="cases-cards"
        >
          {rows.map((r, i) => (
            <li
              key={r.id}
              data-card={r.externalId}
              className={`rounded-lg border p-3 text-sm shadow-sm ${selected.has(r.id) ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-white'}`}
            >
              <div className="flex items-start gap-2">
                {canAssign ? (
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={t('cases.list.select', { id: r.externalId })}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(i, false)}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="font-mono text-base font-semibold text-indigo-ink-700 underline-offset-2 hover:underline"
                    aria-label={t('cases.list.open', { id: r.externalId })}
                    onClick={() => setOpen(r.id)}
                  >
                    {r.externalId}
                  </button>
                  <div className="mt-1">
                    <StatusCell r={r} own={!canReadAll} />
                  </div>
                </div>
                {mine && canConductHere ? (
                  <RowAction projectId={projectId} r={r} me={me.data?.user.id} />
                ) : null}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                {shownFields.map((f) => (
                  <div key={f.name} className="contents">
                    <dt className="text-slate-600">{f.label ?? f.name}</dt>
                    <dd className="min-w-0 break-words">
                      <SampleValue value={r.sample[f.name]} />
                    </dd>
                  </div>
                ))}
                {canReadAll ? (
                  <>
                    <dt className="text-slate-600">{t('cases.list.col.assignedTo')}</dt>
                    <dd>
                      {r.assignedName ?? '—'}
                      {r.assignedTo &&
                      r.assignedAt &&
                      (r.status === 'assigned' || r.status === 'in_progress')
                        ? ` · ${assignedAge(t, r.assignedAt)}`
                        : ''}
                    </dd>
                  </>
                ) : null}
                {r.priority ? (
                  <>
                    <dt className="text-slate-600">{t('cases.list.col.priority')}</dt>
                    <dd>{r.priority}</dd>
                  </>
                ) : null}
              </dl>
            </li>
          ))}
          {data && !rows.length ? (
            <li className="rounded-lg border border-slate-200 bg-white p-4 text-slate-600">
              {data.total === 0 && !status && !assignedTo && !team && !quick && !term && !filter
                ? t('cases.list.none')
                : t('cases.list.empty')}
            </li>
          ) : null}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          {/* One line per case: cells do not wrap (the table scrolls sideways instead). */}
          <table
            className="w-full min-w-[40rem] text-sm [&_td]:whitespace-nowrap"
            data-testid="cases-table"
            aria-busy={list.isFetching}
          >
            <caption className="sr-only">
              {t('cases.list.title')} · {t('cases.list.total', { count: data?.total ?? 0 })}
            </caption>
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                {canAssign ? (
                  <th scope="col" className="w-8 px-2 py-2">
                    <input
                      type="checkbox"
                      aria-label={t('cases.list.selectPage')}
                      checked={allOnPage}
                      // Not while the previous list is shown during a reload.
                      disabled={list.isPlaceholderData}
                      onChange={() => {
                        const next = new Set(selected);
                        rows.forEach((r) => (allOnPage ? next.delete(r.id) : next.add(r.id)));
                        setSelected(next);
                      }}
                    />
                  </th>
                ) : null}
                <th scope="col" className="px-2 py-2">
                  {t('cases.list.col.externalId')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('cases.list.col.status')}
                </th>
                {canReadAll ? (
                  <>
                    <th scope="col" className="px-2 py-2">
                      {t('cases.list.col.assignedTo')}
                    </th>
                    <th scope="col" className="px-2 py-2">
                      {t('cases.list.col.assignedAt')}
                    </th>
                    <th scope="col" className="px-2 py-2">
                      {t('cases.list.col.since')}
                    </th>
                  </>
                ) : null}
                <th scope="col" className="px-2 py-2">
                  {t('cases.list.col.priority')}
                </th>
                {shownFields.map((f) => (
                  <th key={f.name} scope="col" className="px-2 py-2">
                    <FieldName field={f} />
                  </th>
                ))}
                {mine && canConductHere ? (
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">{t('cases.list.col.action')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  className={selected.has(r.id) ? 'bg-indigo-50' : undefined}
                  data-case={r.externalId}
                >
                  {canAssign ? (
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={t('cases.list.select', { id: r.externalId })}
                        checked={selected.has(r.id)}
                        onChange={() => undefined}
                        onClick={(e) => toggle(i, e.shiftKey)}
                        onKeyDown={(e) => {
                          if (e.key === ' ') {
                            e.preventDefault();
                            toggle(i, e.shiftKey);
                          }
                        }}
                      />
                    </td>
                  ) : null}
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      className="font-mono text-indigo-ink-700 underline-offset-2 hover:underline"
                      aria-label={t('cases.list.open', { id: r.externalId })}
                      onClick={() => setOpen(r.id)}
                    >
                      {r.externalId}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusCell r={r} own={!canReadAll} />
                  </td>
                  {canReadAll ? (
                    <>
                      <td className="px-2 py-1.5">{r.assignedName ?? '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {r.assignedTo && r.assignedAt ? dateTime(r.assignedAt) : '—'}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap" data-col="since">
                        {/* The clock stops once the case is closed. */}
                        {r.assignedTo &&
                        r.assignedAt &&
                        (r.status === 'assigned' || r.status === 'in_progress')
                          ? assignedAge(t, r.assignedAt)
                          : '—'}
                        {r.assignedAt &&
                        (r.status === 'assigned' || r.status === 'in_progress') &&
                        dueAt(r.assignedAt, data?.caseExpiryHours) ? (
                          <span className="ml-1.5 text-xs text-slate-600" data-col="due">
                            ·{' '}
                            {t('cases.list.dueOn', {
                              date: dateTime(dueAt(r.assignedAt, data?.caseExpiryHours)!),
                            })}
                          </span>
                        ) : null}
                      </td>
                    </>
                  ) : null}
                  <td className="px-2 py-1.5">{r.priority}</td>
                  {shownFields.map((f) => (
                    <td key={f.name} className="px-2 py-1.5">
                      <SampleValue value={r.sample[f.name]} />
                    </td>
                  ))}
                  {mine && canConductHere ? (
                    <td className="px-2 py-1.5 text-right">
                      <RowAction projectId={projectId} r={r} me={me.data?.user.id} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {data && !rows.length ? (
            <p className="p-4 text-sm text-slate-600">
              {data.total === 0 && !status && !assignedTo && !team && !quick && !term && !filter
                ? t('cases.list.none')
                : t('cases.list.empty')}
            </p>
          ) : null}
        </div>
      )}
      <nav className="flex items-center gap-3 text-sm" aria-label={t('cases.list.title')}>
        <button
          type="button"
          className={smallBtn}
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          {t('cases.list.prev')}
        </button>
        <span>
          {t('cases.list.page', { page, pages })} ·{' '}
          {t('cases.list.total', { count: data?.total ?? 0 })}
        </span>
        <button
          type="button"
          className={smallBtn}
          disabled={page >= pages}
          onClick={() => setPage(page + 1)}
        >
          {t('cases.list.next')}
        </button>
      </nav>
      {/* Footnotes of the table. */}
      {!canReadAll && pool ? (
        <p className="text-xs text-slate-600">{t('cases.list.poolNote')}</p>
      ) : null}
      {data?.piiMasked ? (
        <p className="text-xs text-slate-600" data-testid="pii-note">
          {data.autoReveal ? t('cases.list.piiAuto') : t('cases.list.piiNote')}
        </p>
      ) : null}
      {/* What to do with the ticked cases, at the bottom while some are ticked. */}
      {canAssign ? (
        <BulkBar
          count={selected.size}
          label={t('cases.list.selectedRegion', { count: selected.size })}
          onClear={() => setSelected(new Set())}
        >
          <span className="whitespace-nowrap font-semibold">
            {t('cases.list.selected', { count: selected.size })}
          </span>
          <label className="sr-only" htmlFor="assign-how">
            {t('cases.list.assignHow')}
          </label>
          <select
            id="assign-how"
            className={`${controlCls} h-8 w-auto max-w-[9.5rem] shrink-0 py-0`}
            value={how}
            onChange={(e) => setHow(e.target.value as 'person' | 'rules' | 'random')}
          >
            <option value="person">{t('cases.list.toPerson')}</option>
            <option value="rules">{t('cases.list.byRules')}</option>
            <option value="random">{t('cases.list.random')}</option>
          </select>
          {how === 'person' ? (
            <>
              <label className="sr-only" htmlFor="assign-to">
                {t('cases.list.assignSelected')}
              </label>
              <select
                id="assign-to"
                className={`${controlCls} h-8 w-auto min-w-[8rem] max-w-[9.5rem] shrink-0 py-0`}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">{t('cases.list.pickPerson')}</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="h-8 whitespace-nowrap"
            disabled={
              how === 'random'
                ? false
                : how === 'rules'
                  ? byRules.isPending
                  : !assignee || assign.isPending
            }
            onClick={() =>
              how === 'random'
                ? setDistributing([...selected])
                : how === 'rules'
                  ? byRules.mutate([...selected])
                  : assign.mutate({ caseIds: [...selected], userId: assignee })
            }
          >
            {t('cases.list.assign')}
          </Button>
          <button
            type="button"
            className={`${smallBtn} h-8 whitespace-nowrap`}
            disabled={assign.isPending}
            onClick={() => assign.mutate({ caseIds: [...selected], userId: null })}
          >
            {t('cases.list.unassign')}
          </button>
          <BulkWithdraw
            projectId={projectId}
            ids={[...selected]}
            onDone={(m) => {
              setSelected(new Set());
              setMessage(m);
            }}
          />
        </BulkBar>
      ) : null}
      {open ? (
        <CaseDrawer
          projectId={projectId}
          caseId={open}
          fields={fields}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/** The list's quick filters (the deadline ones only when the project sets a case deadline). */
const QUICK = ['due_soon', 'overdue', 'no_attempt'] as const;
type Quick = (typeof QUICK)[number];

interface GoalRow {
  userId: string | null;
  frequency: string;
  endsOn: string;
  target: number;
  completes: number;
  state: 'upcoming' | 'on_track' | 'behind' | 'met' | 'missed' | 'rest';
}

/** The person's own goal in force today, a weekly one first; none when they have no goal. */
export function myGoal(
  goals: GoalRow[],
  userId: string | undefined,
  today = new Date().toLocaleDateString('en-CA'),
) {
  // `met` also marks a goal whose period is over: only those still running count.
  const live = goals.filter(
    (g) =>
      g.userId === userId &&
      userId !== undefined &&
      g.endsOn >= today &&
      (g.state === 'on_track' || g.state === 'behind' || g.state === 'met'),
  );
  return live.find((g) => g.frequency === 'weekly') ?? live[0];
}

/** Which window a goal's completes are counted over, for its card's title. */
const goalWindow = (f: string) =>
  f === 'weekly'
    ? 'weekly'
    : f === 'monthly'
      ? 'monthly'
      : f === 'daily' || f === 'business_days'
        ? 'daily'
        : 'period';

const reviewTone: Record<NonNullable<CaseRow['review']>, Tone> = {
  pending: 'info',
  approved: 'success',
  returned: 'warning',
  rejected: 'danger',
};

/**
 * A case's state in the list: its status and, below, what to know about it — free to take,
 * returned, its result and review once finished, or its next contact.
 */
function StatusCell({ r, own }: { r: CaseRow; own: boolean }) {
  const { t } = useTranslation();
  const open = r.status === 'assigned' || r.status === 'in_progress';
  return (
    <>
      <StatusBadge status={r.status} />
      {own && !r.assignedTo ? (
        <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-ink-900">
          {t('cases.list.availableBadge')}
        </span>
      ) : null}
      {r.returned && open ? (
        <span
          className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-ink-900"
          data-testid="returned-badge"
        >
          {t('cases.list.returnedBadge')}
        </span>
      ) : null}
      {r.status === 'finalised' && (r.disposition || r.review) ? (
        <span
          className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap text-xs text-slate-600"
          data-col="result"
        >
          {r.disposition ? dispositionLabel(t, r.disposition) : null}
          {r.review ? (
            <span data-review={r.review}>
              {r.disposition ? '· ' : ''}
              {t('cases.list.review')}{' '}
              <Badge tone={reviewTone[r.review]}>{t(`cases.list.reviewState.${r.review}`)}</Badge>
            </span>
          ) : null}
        </span>
      ) : null}
      {r.nextContactAt && open ? (
        <span className="block text-xs text-slate-600" data-col="next-contact">
          {t('cases.list.nextContact', { date: dateTime(r.nextContactAt) })}
        </span>
      ) : null}
    </>
  );
}

/** Start or continue the interview of one's own open case, straight from the list. */
function RowAction({ projectId, r, me }: { projectId: string; r: CaseRow; me?: string }) {
  const { t } = useTranslation();
  if (!(r.status === 'assigned' || r.status === 'in_progress') || !me || r.assignedTo !== me)
    return null;
  const resume = r.status === 'in_progress';
  return (
    <StartInterview
      projectId={projectId}
      caseId={r.id}
      externalId={r.externalId}
      resume={resume}
      compact={{
        label: t(resume ? 'cases.list.continue' : 'cases.list.start'),
        ariaLabel: t(resume ? 'cases.list.continueCase' : 'cases.list.startCase', {
          id: r.externalId,
        }),
      }}
    />
  );
}

const statusTone: Record<string, Tone> = {
  fresh: 'neutral',
  assigned: 'info',
  in_progress: 'warning',
  finalised: 'success',
  withdrawn: 'danger',
};

interface Kpi {
  key: string;
  n: number;
  /** A second figure for the definition line (the completes among the finalised). */
  sub?: number;
  /** The status a click on the card filters the list by. */
  status?: CaseStatus;
}

/**
 * The figures above the list. Managers get one card per status, with the same names as the
 * dashboard, so they add up to the total; interviewers get their own work: what to do, what is
 * due, what came back and what they finished.
 */
export function caseKpis(data: CaseList | undefined, mine: boolean, pool: boolean): Kpi[] {
  const c = data?.counts ?? {};
  const n = (s: CaseStatus) => c[s] ?? 0;
  const finalised: Kpi = {
    key: 'finalised',
    n: n('finalised'),
    sub: data?.completed ?? 0,
    status: 'finalised',
  };
  if (!mine)
    return STATUSES.map((s) => (s === 'finalised' ? finalised : { key: s, n: n(s), status: s }));
  return [
    { key: 'todo', n: n('assigned') + n('in_progress') },
    { key: 'due', n: data?.due ?? 0 },
    { key: 'returned', n: data?.returned ?? 0 },
    finalised,
    ...(pool ? [{ key: 'available', n: n('fresh'), status: 'fresh' } as Kpi] : []),
  ];
}

/** A sample field's name: its label, with the variable code under it when they differ. */
function FieldName({ field }: { field: SampleField }) {
  if (!field.label || field.label === field.name)
    return <span className="font-mono">{field.name}</span>;
  return (
    <>
      {field.label}
      <span className="block font-mono text-[11px] font-normal text-slate-600">{field.name}</span>
    </>
  );
}

/** What the API sends in place of a hidden personal value. */
const MASK = '•••';

/** A sample value; a hidden personal one shows as a padlock and the word “hidden”. */
function SampleValue({ value }: { value: unknown }) {
  const { t } = useTranslation();
  if (value === MASK)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-slate-600" data-masked="">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 fill-current">
          <path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z" />
        </svg>
        {t('cases.list.hidden')}
      </span>
    );
  return <>{formatValue(value)}</>;
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <Badge tone={statusTone[status] ?? 'neutral'}>{t(`cases.status.${status}`)}</Badge>;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

interface CaseDetail extends CaseRow {
  attempts?: number;
  contacts: {
    id: string;
    type: string;
    value: string;
    label: string | null;
    valid: boolean;
    lat?: number | null;
    lng?: number | null;
    geocodeQuality?: string | null;
  }[];
  elsewhere?: { projectId: string; name: string; cases: number }[];
  history: { type: string; details: Record<string, unknown>; at: string; actor: string | null }[];
  pii: { masked: boolean; canReveal: boolean; auto: boolean };
  anonymisedAt: string | null;
  canClaim: boolean;
  canRelease: boolean;
  canForceRelease?: boolean;
  checkedOutAt?: string | null;
  selectionRole?: string | null;
  inclusionProb?: number | null;
  baseWeight?: number | null;
  substitutes?: { id: string; externalId: string } | null;
  substitutedBy?: { id: string; externalId: string } | null;
  canSubstitute?: boolean;
  /** Phone attempts the project allows. */
  maxAttempts?: number;
  /** Closed after its last call attempt, and the caller may give it a new round. */
  canReopenAttempts?: boolean;
}

/** Where the case comes from in the sample (S1), and its substitute by the plan's rule. */
function SamplingFacts({
  projectId,
  caseId,
  c,
  onDone,
}: {
  projectId: string;
  caseId: string;
  c: CaseDetail;
  onDone(): Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const substitute = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/sampling/cases/${caseId}/substitute`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: async () => {
      setAsking(false);
      setNote(t('cases.sampling.substituted'));
      await onDone();
    },
    onError: (e) => setNote(localiseError(t, e)),
  });
  const n = (x: number | null | undefined, digits: number) =>
    x == null ? '—' : x.toLocaleString(i18n.language, { maximumFractionDigits: digits });
  return (
    <section aria-labelledby="cd-sampling" data-testid="case-sampling">
      <h3 id="cd-sampling" className="mb-1 font-semibold">
        {t('cases.sampling.role')}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-slate-600">{t('cases.sampling.role')}</dt>
        <dd data-role={c.selectionRole}>
          {t(`cases.sampling.roleOne.${c.selectionRole}`, { defaultValue: c.selectionRole ?? '' })}
        </dd>
        <dt className="text-slate-600">{t('cases.sampling.inclusion')}</dt>
        <dd>{n(c.inclusionProb, 6)}</dd>
        <dt className="text-slate-600">{t('cases.sampling.weight')}</dt>
        <dd>{n(c.baseWeight, 3)}</dd>
        {c.substitutes ? (
          <>
            <dt className="text-slate-600">{t('cases.sampling.substituteFor')}</dt>
            <dd className="font-mono">{c.substitutes.externalId}</dd>
          </>
        ) : null}
        {c.substitutedBy ? (
          <>
            <dt className="text-slate-600">{t('cases.sampling.substitutedBy')}</dt>
            <dd className="font-mono" data-testid="substituted-by">
              {c.substitutedBy.externalId}
            </dd>
          </>
        ) : null}
      </dl>
      {c.canSubstitute ? (
        asking ? (
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) substitute.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t('cases.sampling.substituteReason')}</span>
              <input
                className={`${controlCls} w-72`}
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={!reason.trim() || substitute.isPending}>
              {t('cases.sampling.substituteGo')}
            </Button>
          </form>
        ) : (
          <button type="button" className={`${smallBtn} mt-2`} onClick={() => setAsking(true)}>
            {t('cases.sampling.substitute')}
          </button>
        )
      ) : null}
      <p role="status" aria-live="polite" className="empty:hidden">
        {note}
      </p>
    </section>
  );
}

function CaseDrawer({
  projectId,
  caseId,
  fields,
  onClose,
}: {
  projectId: string;
  caseId: string;
  fields: SampleField[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canEdit = useCan('cases.edit', projectId);
  const canConduct = useCan('interviews.conduct', projectId);
  const me = useMe();
  const [reveal, setReveal] = useState(false);
  const detail = useQuery({
    queryKey: ['case', caseId, reveal],
    queryFn: () =>
      api<CaseDetail>(`/projects/${projectId}/cases/${caseId}${reveal ? '?reveal=pii' : ''}`),
    gcTime: 0,
  });
  const [priority, setPriority] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  const c = detail.data;
  const casePriority = c?.priority;
  useEffect(() => {
    if (casePriority !== undefined) setPriority(String(casePriority));
  }, [casePriority]);
  const [note, setNote] = useState('');
  // Worded when shown, so it follows the language.
  const [reopened, setReopened] = useState<number | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['case', caseId] });
    await qc.invalidateQueries({ queryKey: ['cases', projectId] });
  };
  const hand = useMutation({
    mutationFn: (action: 'claim' | 'release' | 'force-release') =>
      api(`/projects/${projectId}/cases/${caseId}/${action}`, { method: 'POST' }),
    onSuccess: async (_r, action) => {
      setNote(
        t(
          action === 'claim'
            ? 'cases.detail.claimed'
            : action === 'release'
              ? 'cases.detail.released'
              : 'cases.detail.deviceReleased',
        ),
      );
      await refresh();
    },
    onError: async (e) => {
      setNote(localiseError(t, e));
      await refresh();
    },
  });
  // A case closed after its last call attempt gets a new round (supervisors of phone work).
  const reopen = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/cases/${caseId}/reopen-attempts`, { method: 'POST' }),
    onSuccess: async () => {
      setNote('');
      setReopened(c?.maxAttempts ?? 0);
      await refresh();
    },
    onError: (e) => {
      setReopened(null);
      setNote(localiseError(t, e));
    },
  });
  const patch = useMutation({
    mutationFn: (body: object) =>
      api(`/projects/${projectId}/cases/${caseId}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
  });

  const header = c ? (
    <div className="flex flex-col gap-2 text-sm" data-testid="case-header">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={c.status} />
        {c.disposition ? (
          <span data-testid="case-disposition">
            ·{' '}
            {t(`analysis.dispositionLabels.${c.disposition}`, {
              defaultValue: c.disposition,
            })}
          </span>
        ) : null}
        {c.attempts ? (
          <span data-testid="case-attempts">
            ·{' '}
            {c.maxAttempts
              ? t('cases.detail.attemptsOf', { count: c.attempts, max: c.maxAttempts })
              : t('cases.detail.attempts', { count: c.attempts })}
          </span>
        ) : null}
        {c.assignedName ? (
          <span>
            · {c.assignedName}
            {c.assignedAt
              ? ` · ${t('cases.list.assignedOn', { date: dateTime(c.assignedAt), age: assignedAge(t, c.assignedAt) })}`
              : ''}
          </span>
        ) : null}
        {c.pii.masked ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-slate-600">{t('cases.detail.masked')}</span>
            {c.pii.canReveal ? (
              <button
                ref={first}
                type="button"
                className={smallBtn}
                title={t('cases.detail.revealNote')}
                onClick={() => setReveal(true)}
              >
                {t('cases.detail.reveal')}
              </button>
            ) : null}
          </span>
        ) : c.pii.auto ? (
          <span className="ml-auto text-slate-600" data-testid="pii-confidential">
            {t('cases.detail.autoShown')} {t('cases.detail.confidential')}
          </span>
        ) : reveal ? (
          <span className="ml-auto text-slate-600" data-testid="pii-confidential">
            {t('cases.detail.confidential')}
          </span>
        ) : null}
      </div>
      {c.checkedOutAt ? (
        <p className="flex flex-wrap items-center gap-2 text-slate-700" data-testid="checked-out">
          {t('cases.detail.onDevice', {
            time: dateTime(c.checkedOutAt),
          })}
          {c.canForceRelease ? (
            <button
              type="button"
              className={smallBtn}
              disabled={hand.isPending}
              onClick={() => hand.mutate('force-release')}
            >
              {t('cases.detail.forceRelease')}
            </button>
          ) : null}
        </p>
      ) : null}
      {c.canClaim || c.canRelease || c.canReopenAttempts || note || reopened !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          {c.canReopenAttempts ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              busy={reopen.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    t('cases.detail.reopenAttemptsConfirm', {
                      id: c.externalId,
                      count: c.maxAttempts ?? 0,
                    }),
                  )
                )
                  reopen.mutate();
              }}
            >
              {t('cases.detail.reopenAttempts', { count: c.maxAttempts ?? 0 })}
            </Button>
          ) : null}
          {c.canClaim ? (
            <Button
              type="button"
              size="sm"
              disabled={hand.isPending}
              onClick={() => hand.mutate('claim')}
            >
              {t('cases.detail.claim')}
            </Button>
          ) : null}
          {c.canRelease ? (
            <button
              type="button"
              className={smallBtn}
              disabled={hand.isPending}
              onClick={() => hand.mutate('release')}
            >
              {t('cases.detail.release')}
            </button>
          ) : null}
          <p role="status" aria-live="polite">
            {note ||
              (reopened !== null ? t('cases.detail.attemptsReopened', { count: reopened }) : '')}
          </p>
        </div>
      ) : null}
      {canConduct &&
      (c.status === 'assigned' || c.status === 'in_progress' || c.canClaim) &&
      (c.assignedTo === me.data?.user.id || c.canClaim) ? (
        <StartInterview
          projectId={projectId}
          caseId={caseId}
          externalId={c.externalId}
          resume={c.status === 'in_progress'}
        />
      ) : null}
    </div>
  ) : null;

  return (
    <Dialog
      title={t('cases.detail.title', { id: c?.externalId ?? '…' })}
      onClose={onClose}
      wide
      header={header}
    >
      {!c ? (
        <p aria-busy="true">…</p>
      ) : (
        <div
          className="flex flex-col gap-4 text-sm [&>section]:border-t [&>section]:border-slate-200 [&>section]:pt-3"
          data-testid="case-detail"
        >
          <section aria-labelledby="cd-sample">
            <h3 id="cd-sample" className="mb-1 font-semibold">
              {t('cases.detail.sample')}
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {Object.entries(c.sample).map(([k, v]) => {
                const f = fields.find((x) => x.name === k);
                return (
                  <div key={k} className="contents">
                    <dt className="text-slate-600">
                      <FieldName field={f ?? { name: k, label: null, type: 'text', pii: false }} />
                    </dt>
                    <dd>
                      <SampleValue value={v} />
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
          {c.selectionRole ? (
            <SamplingFacts projectId={projectId} caseId={caseId} c={c} onDone={refresh} />
          ) : null}
          <section aria-labelledby="cd-contacts">
            <h3 id="cd-contacts" className="mb-1 font-semibold">
              {t('cases.detail.contacts')}
            </h3>
            {c.contacts.length ? (
              <ul className="flex flex-col gap-0.5" data-testid="contacts">
                {c.contacts.map((x) => (
                  <li key={x.id}>
                    <span className="text-slate-600">{x.label ?? x.type}:</span> {x.value}
                    {x.lat != null && x.lng != null ? (
                      <>
                        {' '}
                        <span
                          className="font-mono text-xs text-slate-600"
                          data-testid="coordinates"
                        >
                          ({x.lat.toFixed(5)}, {x.lng.toFixed(5)})
                        </span>{' '}
                        <a
                          className="text-xs text-indigo-ink-700 underline"
                          href={`https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lng}#map=17/${x.lat}/${x.lng}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('cases.detail.openMap')}
                        </a>
                      </>
                    ) : x.geocodeQuality === 'not_found' ? (
                      <span className="text-xs text-slate-600">
                        {' '}
                        · {t('cases.detail.notFound')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-600">{t('cases.detail.noContacts')}</p>
            )}
          </section>
          {c.elsewhere?.length ? (
            <p
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
              data-testid="elsewhere"
            >
              {t('cases.detail.elsewhere', {
                list: c.elsewhere
                  .map((p) => t('cases.detail.elsewhereCases', { name: p.name, count: p.cases }))
                  .join(', '),
              })}
            </p>
          ) : null}
          {canEdit ? (
            <section aria-labelledby="cd-manage" className="flex flex-wrap items-end gap-2">
              <h3 id="cd-manage" className="w-full font-semibold">
                {t('cases.detail.manage')}
              </h3>
              <label className="flex flex-col gap-1">
                <span className="font-medium">{t('cases.detail.priority')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className={`${controlCls} w-20`}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={smallBtn}
                disabled={!/^-?\d+$/.test(priority)}
                onClick={() => patch.mutate({ priority: Number(priority) })}
              >
                {t('cases.detail.save')}
              </button>
              {c.status === 'finalised' &&
              (c.disposition === 'EXPIRED' || c.disposition === 'FIELDWORK_CLOSED') ? (
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => patch.mutate({ status: 'fresh' })}
                >
                  {t('cases.detail.reopen')}
                </button>
              ) : c.status === 'withdrawn' ? (
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => patch.mutate({ status: 'fresh' })}
                >
                  {t('cases.detail.reinstate')}
                </button>
              ) : c.status === 'fresh' || c.status === 'assigned' ? (
                <button
                  type="button"
                  className={dangerBtn}
                  onClick={() => patch.mutate({ status: 'withdrawn' })}
                >
                  {t('cases.detail.withdraw')}
                </button>
              ) : null}
              {c.status !== 'withdrawn' && c.disposition !== 'MISIDENTIFIED' ? (
                <Misidentified projectId={projectId} caseId={caseId} />
              ) : null}
            </section>
          ) : null}
          <InterviewHistory projectId={projectId} caseId={caseId} />
          <CallHistory projectId={projectId} caseId={caseId} />
          <PersonalData
            projectId={projectId}
            caseId={caseId}
            externalId={c.externalId}
            anonymisedAt={c.anonymisedAt}
          />
          <section aria-labelledby="cd-history">
            <h3 id="cd-history" className="mb-1 font-semibold">
              {t('cases.detail.history')}
            </h3>
            <ol className="flex flex-col gap-0.5">
              {c.history.map((h, i) => (
                <li key={i}>
                  <time className="text-slate-600">{dateTime(h.at)}</time> ·{' '}
                  {t(`cases.detail.event.${h.type}`, { defaultValue: h.type })}
                  {h.actor ? ` · ${h.actor}` : ''}
                </li>
              ))}
            </ol>
          </section>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('cases.detail.close')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
