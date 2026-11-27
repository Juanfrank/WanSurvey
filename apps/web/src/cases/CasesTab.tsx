import './sampling-i18n.js';
import { BulkWithdraw } from './BulkWithdraw.js';
import { dangerBtn, Misidentified } from './Misidentified.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api.js';
import { dispositionLabel, localiseError } from '../i18n-messages.js';
import { ConditionBuilder } from '../designer/ConditionBuilder.js';
import { Dialog } from '../designer/Dialog.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { useCan } from '../designer/hooks.js';
import { caseVariables } from '../designer/vars.js';
import { Button } from '../routes/ui.js';
import { CaseMap } from './CaseMap.js';
import { PersonalData } from './PersonalData.js';
import { ReturnedToMe } from '../review/ReturnedToMe.js';
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
import { dateTime } from '../format.js';
import { AssignmentsTab } from './AssignmentsTab.js';
import { DistributeDialog } from './DistributeDialog.js';
import { useQuestionnaireScope } from './scope.js';

const MAX_FIELD_COLUMNS = 4;
/** The map view, column picker and rule filter come back later; their code stays. */
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
  const [status, setStatus] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [cols, setCols] = useState<string[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [assignee, setAssignee] = useState('');
  const [message, setMessage] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [how, setHow] = useState<'person' | 'rules' | 'random'>('person');
  const [distributing, setDistributing] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const questionnaire = useQuestionnaireScope();
  const openCase = useCallback((id: string) => setOpen(id), []);
  const limit = 25;

  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [status, assignedTo, term, filter]);

  const list = useQuery({
    queryKey: ['cases', projectId, questionnaire, status, assignedTo, term, filter, page],
    queryFn: () =>
      api<CaseList>(
        `/projects/${projectId}/cases?${qs({ questionnaireId: questionnaire, status, assignedTo, q: term, filter, page, limit, sort: mine ? 'todo' : undefined })}`,
      ),
    placeholderData: (prev) => prev,
  });
  const people = useAssignees(projectId, canAssign);
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
  // The selected cases (or every free one) go out by the questionnaire's assignment rules.
  const byRules = useMutation({
    mutationFn: () =>
      api<{ assigned: number }>(`/projects/${projectId}/assignments/apply`, {
        method: 'POST',
        body: {
          ...(selected.size ? { caseIds: [...selected] } : {}),
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
        <h2 id="case-kpis" className="text-sm font-semibold text-slate-700">
          {mine ? t('cases.list.kpi.mineTitle') : t('cases.list.kpi.title')} ·{' '}
          <span data-testid="kpi-total">{data ? kpiTotal : '…'}</span>
          {!mine && questionnaire && scoped ? (
            <span className="ml-2 font-normal text-slate-600">{t('cases.list.kpi.scope')}</span>
          ) : null}
        </h2>
        <ul
          aria-label={t('cases.list.kpi.label')}
          className={`grid grid-cols-2 gap-3 ${kpis.length > 4 ? 'sm:grid-cols-3 lg:grid-cols-5' : 'sm:grid-cols-4'}`}
        >
          {kpis.map((k) => {
            const body = (
              <>
                <span className="block text-xs font-medium text-slate-600">
                  {t(`cases.list.kpi.${k.key}`)}
                </span>
                <span className="block text-2xl font-bold tabular-nums" data-n="">
                  {data ? k.n : '…'}
                </span>
                <span className="block text-xs text-slate-600">
                  {t(`cases.list.kpi.def.${k.key}`, { count: k.sub ?? 0 })}
                </span>
              </>
            );
            const card = 'h-full w-full rounded-lg border bg-white p-3 text-left shadow-sm';
            return (
              <li key={k.key} data-kpi={k.key}>
                {k.status ? (
                  <button
                    type="button"
                    aria-pressed={status === k.status}
                    title={t('cases.list.kpi.filterBy')}
                    className={`${card} border-slate-200 hover:border-indigo-400 aria-pressed:border-indigo-500 aria-pressed:bg-indigo-50`}
                    onClick={() => setStatus(status === k.status ? '' : k.status!)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={`${card} border-slate-200`}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('cases.list.search')}</span>
          <input
            type="search"
            className={`${inputCls} w-56`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
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
      </div>
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

      {canEditCases && fields.length ? <FieldLabels projectId={projectId} fields={fields} /> : null}

      <p role="status" aria-live="polite" className="text-sm text-slate-700">
        {message}
      </p>

      {/* Every control the same height (h-8); the row wraps when they do not fit. */}
      {canAssign ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-sm">
          <span className="whitespace-nowrap">
            {selected.size
              ? t('cases.list.selected', { count: selected.size })
              : how === 'rules'
                ? t('cases.list.byRulesAll')
                : how === 'random'
                  ? t('cases.list.randomAll')
                  : filter
                    ? t('cases.list.assignMatching')
                    : t('cases.list.assignSelected')}
          </span>
          <label className="sr-only" htmlFor="assign-how">
            {t('cases.list.assignHow')}
          </label>
          <select
            id="assign-how"
            className={`${controlCls} h-8 w-auto shrink-0 py-0`}
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
                className={`${controlCls} h-8 w-auto min-w-[10rem] max-w-[14rem] shrink-0 py-0`}
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
                  : !assignee || (!selected.size && !filter) || assign.isPending
            }
            onClick={() =>
              how === 'random'
                ? setDistributing(true)
                : how === 'rules'
                  ? byRules.mutate()
                  : assign.mutate(
                      selected.size
                        ? { caseIds: [...selected], userId: assignee }
                        : { filter, userId: assignee },
                    )
            }
          >
            {t('cases.list.assign')}
          </Button>
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
          <button
            type="button"
            className={`${smallBtn} h-8 whitespace-nowrap`}
            disabled={!selected.size || assign.isPending}
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
        </div>
      ) : null}

      {distributing ? (
        <DistributeDialog
          projectId={projectId}
          questionnaireId={questionnaire ?? null}
          caseIds={[...selected]}
          people={people.data ?? []}
          onClose={() => setDistributing(false)}
          onDone={(m) => {
            setDistributing(false);
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
      {!canReadAll && pool ? (
        <p className="text-xs text-slate-600">{t('cases.list.poolNote')}</p>
      ) : null}
      {data?.piiMasked ? (
        <p className="text-xs text-slate-600">
          {data.autoReveal ? t('cases.list.piiAuto') : t('cases.list.piiNote')}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table
          className="w-full min-w-[40rem] text-sm"
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
                  <StatusBadge status={r.status} />
                  {!canReadAll && !r.assignedTo ? (
                    <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-ink-900">
                      {t('cases.list.availableBadge')}
                    </span>
                  ) : null}
                  {r.returned && (r.status === 'assigned' || r.status === 'in_progress') ? (
                    <span
                      className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-ink-900"
                      data-testid="returned-badge"
                    >
                      {t('cases.list.returnedBadge')}
                    </span>
                  ) : null}
                  {r.status === 'finalised' && r.disposition ? (
                    <span className="block text-xs text-slate-600" data-col="result">
                      {dispositionLabel(t, r.disposition)}
                    </span>
                  ) : null}
                  {r.nextContactAt && (r.status === 'assigned' || r.status === 'in_progress') ? (
                    <span className="block text-xs text-slate-600" data-col="next-contact">
                      {t('cases.list.nextContact', { date: dateTime(r.nextContactAt) })}
                    </span>
                  ) : null}
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
                        <span className="block text-xs text-slate-600" data-col="due">
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
                    {r.status === 'assigned' || r.status === 'in_progress' ? (
                      <button
                        type="button"
                        className={`${smallBtn} whitespace-nowrap`}
                        aria-label={t(
                          r.status === 'in_progress'
                            ? 'cases.list.continueCase'
                            : 'cases.list.startCase',
                          { id: r.externalId },
                        )}
                        onClick={() => setOpen(r.id)}
                      >
                        {t(r.status === 'in_progress' ? 'cases.list.continue' : 'cases.list.start')}
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {data && !rows.length ? (
          <p className="p-4 text-sm text-slate-600">
            {data.total === 0 && !status && !assignedTo && !term && !filter
              ? t('cases.list.none')
              : t('cases.list.empty')}
          </p>
        ) : null}
      </div>
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
  const cls: Record<string, string> = {
    fresh: 'bg-slate-100 text-slate-800',
    assigned: 'bg-indigo-100 text-indigo-ink-900',
    in_progress: 'bg-amber-100 text-amber-ink-900',
    finalised: 'bg-emerald-100 text-emerald-ink-900',
    withdrawn: 'bg-red-100 text-red-ink-900',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${cls[status] ?? ''}`}>
      {t(`cases.status.${status}`)}
    </span>
  );
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
  const patch = useMutation({
    mutationFn: (body: object) =>
      api(`/projects/${projectId}/cases/${caseId}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      await qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
  });

  return (
    <Dialog title={t('cases.detail.title', { id: c?.externalId ?? '…' })} onClose={onClose} wide>
      {!c ? (
        <p aria-busy="true">…</p>
      ) : (
        <div
          className="flex flex-col gap-4 text-sm [&>section]:border-t [&>section]:border-slate-200 [&>section]:pt-3"
          data-testid="case-detail"
        >
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
            {c.attempts ? <span>· {t('cases.detail.attempts', { count: c.attempts })}</span> : null}
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
              <span className="ml-auto text-slate-600">{t('cases.detail.autoShown')}</span>
            ) : null}
          </div>
          {c.checkedOutAt ? (
            <p
              className="flex flex-wrap items-center gap-2 text-slate-700"
              data-testid="checked-out"
            >
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
          {c.canClaim || c.canRelease || note ? (
            <div className="flex flex-wrap items-center gap-2">
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
                {note}
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
