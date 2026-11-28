import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeCondition, tryParse } from '@wansurvey/logic';
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type HTMLAttributes,
  type SyntheticEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useQuestionnaireScope, useScoped } from './scope.js';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { ConditionBuilder } from '../designer/ConditionBuilder.js';
import { controlCls, FoldedHelp, NumberField, smallBtn, TextField } from '../designer/fields.js';
import type { Project } from '../designer/ProjectPages.js';
import { caseVariables } from '../designer/vars.js';
import { Button, Card, Drawer, ErrorText, TableScroll } from '../routes/ui.js';
import { STATUSES, useAssignees, useSampleFields } from './hooks.js';
import { dateTime } from '../format.js';

interface Rule {
  id: string;
  userId: string;
  userName: string;
  name: string | null;
  filter: string | null;
  quota: number | null;
  active: boolean;
  matching: number;
  unassigned: number;
  assignedToUser: number;
}

/** `onCancel`, which React's types give only to dialogs, to stop a nested dialog's cancel. */
const stopCancel = {
  onCancel: (e: SyntheticEvent) => e.stopPropagation(),
} as HTMLAttributes<HTMLDivElement>;

/** The workload's first column, held at the left edge while the table scrolls sideways. */
const stickyCol = 'sticky left-0 z-10 bg-white shadow-[1px_0_0_rgb(226_232_240)]';

/** Workload per person, assignment rules, and applying them. */
export function AssignmentsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const people = useAssignees(projectId, true);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const fields = useSampleFields(projectId);
  const variables = useMemo(() => caseVariables(fields.data ?? []), [fields.data]);
  const questionnaire = useQuestionnaireScope();
  const scoped = useScoped();
  const rules = useQuery({
    queryKey: ['rules', projectId, questionnaire],
    queryFn: () => api<Rule[]>(scoped(`/projects/${projectId}/assignments`)),
  });
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [filter, setFilter] = useState<string | undefined>();
  const [quota, setQuota] = useState<number | undefined>();
  const [preview, setPreview] = useState<{ matching: number; unassigned: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [moveFrom, setMoveFrom] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [moved, setMoved] = useState('');
  // The two long forms (move someone's cases, add a rule) wait behind a button each.
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const formId = useId();
  const closeAdding = () => {
    setAdding(false);
    setError(null);
  };

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['rules', projectId] });
    await qc.invalidateQueries({ queryKey: ['assignees', projectId] });
    await qc.invalidateQueries({ queryKey: ['cases', projectId] });
  };
  const fail = (e: unknown) => setError(localiseError(t, e));

  useEffect(() => {
    setPreview(null);
    if (!filter) return;
    const id = setTimeout(() => {
      api<{ matching: number; unassigned: number }>(`/projects/${projectId}/assignments/preview`, {
        method: 'POST',
        body: { filter, ...(questionnaire ? { questionnaireId: questionnaire } : {}) },
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(id);
  }, [filter, projectId, questionnaire]);

  const create = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/assignments`, {
        method: 'POST',
        body: {
          userId,
          filter,
          ...(name ? { name } : {}),
          quota: quota ?? null,
          ...(questionnaire ? { questionnaireId: questionnaire } : {}),
        },
      }),
    onSuccess: async () => {
      setName('');
      setFilter(undefined);
      setQuota(undefined);
      setError(null);
      setAdding(false);
      await refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api(`/projects/${projectId}/assignments/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/assignments/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: fail,
  });
  const apply = useMutation({
    mutationFn: () =>
      api<{ assigned: number }>(`/projects/${projectId}/assignments/apply`, {
        method: 'POST',
        body: questionnaire ? { questionnaireId: questionnaire } : {},
      }),
    onSuccess: async (r) => {
      setMessage(t('cases.rules.applied', { count: r.assigned }));
      await refresh();
    },
    onError: fail,
  });

  // Someone falls ill or leaves: the cases they hold and have not started go to someone else.
  const move = useMutation({
    mutationFn: () =>
      api<{ changed: number }>(`/projects/${projectId}/cases/assign`, {
        method: 'POST',
        // All of their not-started cases, whatever the questionnaire, as the workload counts them.
        body: { fromUserId: moveFrom, userId: moveTo },
      }),
    onSuccess: async (r) => {
      setError(null);
      setMoved(t('cases.rules.moved', { count: r.changed }));
      setMoveFrom('');
      setMoveTo('');
      await refresh();
    },
    onError: fail,
  });
  const nameOf = (id: string) => people.data?.find((p) => p.userId === id)?.name ?? '';
  const movable = people.data?.find((p) => p.userId === moveFrom)?.workload.assigned ?? 0;

  const describe = (src: string | null) => {
    if (!src) return '';
    const p = tryParse(src);
    return p.ok
      ? describeCondition(p.node, {
          ref: (n) => n,
          label: () => null,
          t: (k, v) => t(k, { ...v, ns: 'renderer' }),
        })
      : src;
  };

  return (
    <div className="flex flex-col gap-6">
      {project.data?.settings.assignmentMode === 'pool' ? (
        <p
          className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-ink-950"
          data-testid="pool-mode"
        >
          {t('cases.rules.poolMode')}
        </p>
      ) : null}
      <Card>
        <h2 className="mb-1 text-lg font-semibold">{t('cases.rules.workload')}</h2>
        {people.data?.length ? (
          <TableScroll label={t('cases.rules.workload')}>
            {/* Separate borders: with collapsed ones Chrome lets the cells scrolled under the
                sticky column show through at its edge. The row lines go on the cells. */}
            <table
              className="w-full border-separate border-spacing-0 text-sm [&_tbody_tr+tr>*]:border-t [&_tbody_tr+tr>*]:border-slate-100"
              data-testid="workload"
            >
              <thead className="text-left text-xs whitespace-nowrap text-slate-600">
                <tr>
                  {/* The person stays in view while the figures scroll sideways. */}
                  <th scope="col" className={`${stickyCol} py-1 pr-2`}>
                    {t('cases.rules.person')}
                  </th>
                  {STATUSES.filter((s) => s !== 'fresh').map((s) => (
                    <th key={s} scope="col" className="px-2">
                      {t(`cases.status.${s}`)}
                    </th>
                  ))}
                  <th scope="col" className="px-2" title={t('cases.rules.overdueHint')}>
                    {t('cases.rules.overdue')}
                  </th>
                  <th scope="col" className="px-2" title={t('cases.rules.callbacksHint')}>
                    {t('cases.rules.callbacks')}
                  </th>
                  <th scope="col" className="px-2">
                    {t('cases.rules.completesToday')}
                  </th>
                  <th scope="col" className="px-2">
                    {t('cases.rules.lastContact')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.data.map((p) => (
                  <tr key={p.userId} data-person={p.email} className="whitespace-nowrap">
                    <th scope="row" className={`${stickyCol} py-1 pr-2 text-left font-medium`}>
                      {p.name}
                      {/* Their teams, a detail under the name rather than a column of its own. */}
                      {p.teams?.length ? (
                        <span
                          className="block max-w-[12rem] truncate text-xs font-normal text-slate-600"
                          title={p.teams.map((tm) => tm.name).join(', ')}
                          data-col="teams"
                        >
                          {p.teams.map((tm) => tm.name).join(', ')}
                        </span>
                      ) : null}
                    </th>
                    {STATUSES.filter((s) => s !== 'fresh').map((s) => (
                      <td key={s} data-status={s} className="px-2">
                        {p.workload[s] ?? 0}
                      </td>
                    ))}
                    <td
                      data-col="overdue"
                      className={`px-2 ${p.overdue ? 'font-semibold text-red-ink-800' : ''}`}
                    >
                      {p.overdue ?? '—'}
                    </td>
                    <td data-col="callbacks" className="px-2">
                      {p.callbacks ?? 0}
                    </td>
                    <td data-col="completes-today" className="px-2">
                      {p.completesToday ?? 0}
                    </td>
                    <td data-col="last-contact" className="px-2 whitespace-nowrap text-slate-700">
                      {p.lastContactAt ? dateTime(p.lastContactAt) : t('cases.rules.never')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <p className="text-sm text-slate-600">{t('cases.rules.noPeople')}</p>
        )}
        {(people.data?.length ?? 0) > 1 ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <button
              type="button"
              className={smallBtn}
              aria-expanded={moving}
              onClick={() => setMoving((m) => !m)}
            >
              {t('cases.rules.move')} <span aria-hidden="true">{moving ? '▴' : '▾'}</span>
            </button>
            {!moving && moved ? <span role="status">{moved}</span> : null}
          </div>
        ) : null}
        {(people.data?.length ?? 0) > 1 && moving ? (
          <form
            className="mt-3 flex flex-col gap-2 rounded-md bg-slate-50 p-3 text-sm"
            aria-label={t('cases.rules.move')}
            onSubmit={(e) => {
              e.preventDefault();
              if (
                moveFrom &&
                moveTo &&
                window.confirm(
                  t('cases.rules.confirmMove', {
                    count: movable,
                    from: nameOf(moveFrom),
                    to: nameOf(moveTo),
                  }),
                )
              )
                move.mutate();
            }}
          >
            <FoldedHelp className="max-w-prose">{t('cases.rules.moveHint')}</FoldedHelp>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="font-medium text-slate-700">{t('cases.rules.moveFrom')}</span>
                <select
                  className={controlCls}
                  value={moveFrom}
                  onChange={(e) => {
                    setMoveFrom(e.target.value);
                    if (e.target.value === moveTo) setMoveTo('');
                    setMoved('');
                  }}
                >
                  <option value="">{t('cases.list.pickPerson')}</option>
                  {people.data?.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {t('cases.rules.withAssigned', {
                        name: p.name,
                        count: p.workload.assigned ?? 0,
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-slate-700">{t('cases.rules.moveTo')}</span>
                <select
                  className={controlCls}
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                >
                  <option value="">{t('cases.list.pickPerson')}</option>
                  {people.data
                    ?.filter((p) => p.userId !== moveFrom)
                    .map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                type="submit"
                variant="secondary"
                disabled={!moveFrom || !moveTo || moveFrom === moveTo || !movable || move.isPending}
              >
                {t('cases.rules.moveRun', { count: movable })}
              </Button>
              <span role="status" aria-live="polite">
                {moved}
              </span>
            </div>
          </form>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t('cases.rules.rules')}</h2>
        <FoldedHelp className="-mt-2 max-w-prose">{t('cases.rules.intro')}</FoldedHelp>
        {rules.data?.length ? (
          <ul className="flex flex-col gap-2" data-testid="rules">
            {rules.data.map((r, i) => {
              const label = r.name ?? t('cases.rules.unnamed', { n: i + 1 });
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 p-3 text-sm"
                >
                  <span className="font-medium">{label}</span>
                  <span>→ {r.userName}</span>
                  <span className="text-slate-700">{describe(r.filter)}</span>
                  {r.quota ? <span className="text-slate-600">≤ {r.quota}</span> : null}
                  <span className="text-xs text-slate-600">
                    {t('cases.rules.matching', {
                      matching: r.matching,
                      unassigned: r.unassigned,
                      held: r.assignedToUser,
                    })}
                  </span>
                  <label className="ml-auto flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={r.active}
                      onChange={(e) =>
                        patch.mutate({ id: r.id, body: { active: e.target.checked } })
                      }
                    />
                    {t('cases.rules.active')}
                  </label>
                  <button
                    type="button"
                    className={smallBtn}
                    aria-label={t('cases.rules.remove', { name: label })}
                    onClick={() => {
                      if (window.confirm(t('cases.rules.confirmRemove', { name: label })))
                        remove.mutate(r.id);
                    }}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{t('cases.rules.noRules')}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {t('cases.rules.apply')}
          </Button>
          <span role="status" aria-live="polite" className="text-sm">
            {message}
          </span>
          {/* Errors of the rules, the move and applying them; the add form shows its own. */}
          {adding ? null : <ErrorText>{error}</ErrorText>}
          <Button
            type="button"
            className="ml-auto"
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            + {t('cases.rules.add')}
          </Button>
        </div>
      </Card>

      {adding ? (
        // A side panel over the rules' panel. React passes a dialog's cancel (Escape) on to the
        // dialogs around it: it stops here, so Escape closes this form and not the rules too.
        <div {...stopCancel}>
          <Drawer
            title={t('cases.rules.add')}
            onClose={closeAdding}
            footer={
              <>
                <Button type="button" variant="secondary" onClick={closeAdding}>
                  {t('cases.rules.cancel')}
                </Button>
                <Button
                  type="submit"
                  form={formId}
                  busy={create.isPending}
                  disabled={!userId || !filter}
                >
                  {t('cases.rules.add')}
                </Button>
              </>
            }
          >
            <form
              id={formId}
              aria-label={t('cases.rules.add')}
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (userId && filter && !create.isPending) create.mutate();
              }}
            >
              <div className="grid gap-3">
                <TextField label={t('cases.rules.name')} value={name} onChange={setName} />
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700">{t('cases.rules.who')}</span>
                  <select
                    className={controlCls}
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                  >
                    <option value="">{t('cases.list.pickPerson')}</option>
                    {(people.data ?? []).map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <NumberField
                  label={t('cases.rules.quota')}
                  integer
                  value={quota}
                  onChange={setQuota}
                />
              </div>
              <ConditionBuilder
                label={t('cases.rules.when')}
                value={filter}
                variables={variables}
                onChange={setFilter}
              />
              {preview ? (
                <p className="text-sm" data-testid="rule-preview">
                  {t('cases.rules.preview', preview)}
                </p>
              ) : null}
              <ErrorText>{error}</ErrorText>
            </form>
          </Drawer>
        </div>
      ) : null}
    </div>
  );
}
