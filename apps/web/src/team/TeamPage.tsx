import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  externalAccessOpened,
  ROLE_RANK,
  ROLES,
  rolesRequiring2fa,
  type Role,
} from '@wansurvey/schema';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { permKey, type RolesView } from '../admin/permissions.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls } from '../designer/fields.js';
import { below, Menu, type MenuEntry } from '../designer/Menu.js';
import { dateTime } from '../format.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, Field, PageHeader } from '../routes/ui.js';
import { RoleGuide } from './RoleGuide.js';
import { matchesGrants, redundantRows } from './roles.js';

interface Grant {
  role: Role;
  projectId: string | null;
}

interface Member {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  totpEnabled: boolean;
  status: 'active' | 'invited' | 'deactivated';
  idCode: string | null;
  memberships: Grant[];
  awaitingRole: boolean;
  /** Open cases per project; `onDevice` of them are checked out to a device. */
  workload: {
    projectId: string;
    projectName: string;
    open: number;
    onDevice: number;
    deviceSince: string | null;
  }[];
}

/** A message after an action, kept as a key so it follows a change of language. */
interface Notice {
  key: string;
  vars: Record<string, string>;
  /** Deactivated just now: the message offers to undo it. */
  undo?: Member;
}

interface ProjectRow {
  id: string;
  name: string;
}

type StatusFilter = '' | 'active' | 'invited' | 'deactivated' | 'awaiting';
const STATUSES = ['active', 'invited', 'awaiting', 'deactivated'] as const;

/** Two-step sign-in: not set up at all, or not set up although their role requires it. */
type TwoStepFilter = '' | 'off' | 'required';
const TWO_STEP = ['off', 'required'] as const;

/** The highest organisation-wide rank among some grants (project roles do not count). */
const rankOf = (grants: { role: string; projectId: string | null }[]) =>
  Math.max(0, ...grants.filter((g) => g.projectId === null).map((g) => ROLE_RANK[g.role as Role]));

/**
 * The organisation's people and their roles (H5): invite, change roles per project, send an
 * invitation again, close sessions, deactivate and reactivate. The server enforces the rules
 * (no granting above one's own rank, nobody changes their own roles); the page only offers
 * what will be accepted.
 */
export function TeamPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = !!me.data?.permissions.includes('users.manage');
  const myRank = rankOf(me.data?.memberships ?? []);
  const members = useQuery({
    queryKey: ['team', me.data?.tenantId],
    queryFn: () => api<Member[]>('/users'),
    enabled: !!me.data,
  });
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<ProjectRow[]>('/projects'),
    enabled: !!me.data,
  });
  const projectName = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );
  const tenant = useQuery({
    queryKey: ['tenant', me.data?.tenantId],
    queryFn: () => api<{ settings?: unknown }>('/tenant'),
    enabled: !!me.data,
  });
  const required = rolesRequiring2fa(tenant.data?.settings);
  // Status and two-step filters live in the address: the administration overview links here
  // with one already on.
  const search = useSearch({ strict: false }) as { status?: string; twoStep?: string };
  const navigate = useNavigate();
  const status: StatusFilter = (STATUSES as readonly string[]).includes(search.status ?? '')
    ? (search.status as StatusFilter)
    : '';
  const twoStep: TwoStepFilter = (TWO_STEP as readonly string[]).includes(search.twoStep ?? '')
    ? (search.twoStep as TwoStepFilter)
    : '';
  const setFilter = (k: 'status' | 'twoStep', v: string) =>
    void navigate({
      to: '/admin/users',
      search: { status: status || undefined, twoStep: twoStep || undefined, [k]: v || undefined },
      replace: true,
    });
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [leaving, setLeaving] = useState<Member | null>(null);
  const [menu, setMenu] = useState<{ m: Member; at: { x: number; y: number } } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grantable = ROLES.filter((r) => ROLE_RANK[r] <= myRank);
  const errorText = (e: unknown) =>
    e instanceof ApiError && e.status === 409
      ? t('team.errors.CONFLICT')
      : e instanceof ApiError && e.status === 403
        ? t('team.errors.FORBIDDEN')
        : e instanceof ApiError && e.code === 'REASON_REQUIRED'
          ? t('team.projectPeople.reasonRequired')
          : t('team.errors.generic');
  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] });
  const act = useMutation({
    mutationFn: async ({ m, action }: { m: Member; action: string }) => {
      await api(`/users/${m.id}/${action}`, { method: 'POST' });
      return { m, action };
    },
    onSuccess: async ({ m, action }) => {
      setError(null);
      setLeaving(null);
      setNotice(
        action === 'resend-invitation'
          ? { key: 'team.done.resent', vars: { email: m.email } }
          : action === 'force-logout'
            ? { key: 'team.done.logout', vars: { name: m.name } }
            : action === 'deactivate'
              ? { key: 'team.done.deactivated', vars: { name: m.name }, undo: m }
              : { key: 'team.done.reactivated', vars: { name: m.name } },
      );
      await refresh();
    },
    onError: (e) => {
      setLeaving(null);
      setNotice(null);
      setError(errorText(e));
    },
  });

  const statusOf = (m: Member): StatusFilter => (m.awaitingRole ? 'awaiting' : m.status);
  // Active people only: an invitation or a deactivated account has nothing to set up yet.
  const twoStepOf = (m: Member, f: TwoStepFilter) =>
    !f ||
    (m.status === 'active' &&
      !m.totpEnabled &&
      (f === 'off' || m.memberships.some((g) => required.includes(g.role))));
  const q = query.trim().toLowerCase();
  const shown = (members.data ?? []).filter(
    (m) =>
      (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)) &&
      (!status || statusOf(m) === status) &&
      twoStepOf(m, twoStep) &&
      matchesGrants(m.memberships, roleFilter, projectFilter),
  );
  const canSeeActivity = !!me.data?.permissions.includes('audit.read');
  const manageable = (m: Member) =>
    canManage &&
    m.id !== me.data?.user.id &&
    rankOf(m.memberships) <= myRank &&
    !(m.memberships.some((g) => g.role === 'owner') && myRank < ROLE_RANK.owner);

  const entriesFor = (m: Member): MenuEntry[] => [
    {
      type: 'item',
      id: 'roles',
      label: t('team.editRoles'),
      onSelect: () => setEditing(m),
    },
    ...(m.status === 'invited'
      ? [
          {
            type: 'item' as const,
            id: 'resend',
            label: t('team.resend'),
            onSelect: () => act.mutate({ m, action: 'resend-invitation' }),
          },
        ]
      : []),
    ...(m.status === 'active'
      ? [
          {
            type: 'item' as const,
            id: 'logout',
            label: t('team.forceLogout'),
            onSelect: () => act.mutate({ m, action: 'force-logout' }),
          },
        ]
      : []),
    ...(canSeeActivity
      ? [
          {
            type: 'item' as const,
            id: 'activity',
            label: t('team.activity'),
            onSelect: () => void navigate({ to: '/admin/audit', search: { actor: m.id } }),
          },
        ]
      : []),
    { type: 'separator' },
    m.status === 'deactivated'
      ? {
          type: 'item',
          id: 'reactivate',
          label: t('team.reactivate'),
          onSelect: () => act.mutate({ m, action: 'reactivate' }),
        }
      : {
          type: 'item',
          id: 'deactivate',
          label: t('team.deactivate'),
          onSelect: () => setLeaving(m),
        },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('team.title')}
        actions={
          canManage ? (
            <Button onClick={() => setInviting(true)}>{t('team.invite.open')}</Button>
          ) : null
        }
      />
      <p className="max-w-3xl text-slate-600">
        {t('team.intro')} {canManage ? '' : t('team.readOnly')}
      </p>
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-ink-800"
        >
          {t(notice.key, notice.vars)}
          {notice.undo &&
          members.data?.find((x) => x.id === notice.undo!.id)?.status === 'deactivated' ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="ml-3"
              disabled={act.isPending}
              onClick={() => act.mutate({ m: notice.undo!, action: 'reactivate' })}
            >
              {t('team.reactivate')}
            </Button>
          ) : null}
        </p>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {inviting ? (
        <InviteForm
          grantable={grantable}
          projects={projects.data ?? []}
          onCancel={() => setInviting(false)}
          onInvited={async (email) => {
            setInviting(false);
            setError(null);
            setNotice({ key: 'team.done.invited', vars: { email } });
            await refresh();
          }}
          errorText={errorText}
        />
      ) : null}
      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.search')}</span>
            <input
              type="search"
              className={inputCls}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.statusFilter')}</span>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setFilter('status', e.target.value)}
            >
              <option value="">{t('team.allStatuses')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`team.status.${s}`)} (
                  {(members.data ?? []).filter((m) => statusOf(m) === s).length})
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.twoStepFilter')}</span>
            <select
              className={inputCls}
              value={twoStep}
              onChange={(e) => setFilter('twoStep', e.target.value)}
            >
              <option value="">{t('team.twoStep.any')}</option>
              {TWO_STEP.map((f) => (
                <option key={f} value={f}>
                  {t(`team.twoStep.${f}`)} (
                  {(members.data ?? []).filter((m) => twoStepOf(m, f)).length})
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.roleFilter')}</span>
            <select
              className={inputCls}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="">{t('team.allRoles')}</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`team.roleNames.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.projectFilter')}</span>
            <select
              className={inputCls}
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="">{t('team.allProjects')}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p className="pb-2 text-sm text-slate-600" role="status">
            {t('team.count', { count: shown.length })}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="team">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                <th className="px-2 py-2 font-semibold">{t('team.columns.person')}</th>
                <th className="px-2 py-2 font-semibold">{t('team.columns.roles')}</th>
                <th className="px-2 py-2 text-right font-semibold">{t('team.columns.cases')}</th>
                <th className="px-2 py-2 font-semibold">{t('team.columns.status')}</th>
                <th className="px-2 py-2 font-semibold">{t('team.columns.security')}</th>
                <th className="px-2 py-2">
                  <span className="sr-only">{t('designer.qActions.label')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr
                  key={m.id}
                  className="border-b border-slate-100 align-top"
                  data-member={m.email}
                  data-status={statusOf(m)}
                >
                  <td className="px-2 py-2.5">
                    <div className="font-medium">
                      {m.name}
                      {m.id === me.data?.user.id ? (
                        <span className="ml-1 font-normal text-slate-500">({t('team.you')})</span>
                      ) : null}
                    </div>
                    <div className="text-slate-600">{m.email}</div>
                    {m.idCode ? (
                      <div className="font-mono text-xs text-slate-500">{m.idCode}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5">
                    {m.memberships.length ? (
                      <ul
                        className={`flex flex-col gap-0.5 ${m.status === 'deactivated' ? 'text-slate-500 line-through decoration-slate-400' : ''}`}
                      >
                        {m.memberships.map((g, i) => (
                          <li key={i}>
                            <span className="font-medium">{t(`team.roleNames.${g.role}`)}</span>{' '}
                            <span className="text-slate-600">
                              ·{' '}
                              {g.projectId
                                ? t('team.inProject', {
                                    project: projectName.get(g.projectId) ?? '…',
                                  })
                                : t('team.wholeOrg')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-slate-500">{t('team.noRoles')}</span>
                    )}
                    {m.status === 'deactivated' && m.memberships.length ? (
                      <div className="mt-0.5 text-xs text-slate-600">{t('team.rolesInactive')}</div>
                    ) : null}
                    {m.awaitingRole && manageable(m) ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-1 whitespace-nowrap"
                        aria-label={t('team.assignRoleFor', { name: m.name })}
                        onClick={() => setEditing(m)}
                      >
                        {t('team.assignRole')}
                      </Button>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums" data-testid="open-cases">
                    <OpenCases member={m} />
                  </td>
                  <td className="px-2 py-2.5">
                    <StatusChip status={statusOf(m)} />
                  </td>
                  <td className="px-2 py-2.5">
                    {m.totpEnabled ? t('team.totpOn') : t('team.totpOff')}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    {manageable(m) ? (
                      <button
                        type="button"
                        className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:border-indigo-600"
                        aria-haspopup="menu"
                        aria-expanded={menu?.m.id === m.id}
                        aria-label={t('team.actions', { name: m.name })}
                        onClick={(e) => setMenu({ m, at: below(e.currentTarget) })}
                      >
                        {t('designer.qActions.label')} ▾
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {menu ? (
          <Menu
            label={t('team.actions', { name: menu.m.name })}
            entries={entriesFor(menu.m)}
            at={menu.at}
            onClose={() => setMenu(null)}
          />
        ) : null}
      </Card>
      {leaving ? (
        <DeactivateDialog
          member={leaving}
          pending={act.isPending}
          onCancel={() => setLeaving(null)}
          onConfirm={() => act.mutate({ m: leaving, action: 'deactivate' })}
        />
      ) : null}
      {editing ? (
        <RolesDialog
          member={editing}
          grantable={grantable}
          projects={projects.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setNotice({ key: 'team.done.roles', vars: { name: editing.name } });
            setError(null);
            setEditing(null);
            await refresh();
          }}
          errorText={errorText}
        />
      ) : null}
    </div>
  );
}

/** How many open cases the person has, and how many of them are on a device. */
function OpenCases({ member }: { member: Member }) {
  const { t } = useTranslation();
  const open = member.workload.reduce((n, w) => n + w.open, 0);
  const onDevice = member.workload.reduce((n, w) => n + w.onDevice, 0);
  return (
    <>
      <div>{open}</div>
      {onDevice ? (
        <div className="whitespace-nowrap text-xs text-amber-ink-800">
          {t('team.onDevice', { count: onDevice })}
        </div>
      ) : null}
    </>
  );
}

/**
 * Deactivating someone: what it does, and the open cases they leave behind (per project, with
 * those on a device), so they can be reassigned first.
 */
function DeactivateDialog({
  member,
  pending,
  onCancel,
  onConfirm,
}: {
  member: Member;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog title={t('team.deactivateDialog.title', { name: member.name })} onClose={onCancel}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-slate-700">{t('team.deactivateDialog.body')}</p>
        {member.workload.length ? (
          <div className="rounded-md bg-amber-50 px-3 py-2 text-amber-ink-800">
            <ul className="flex flex-col gap-2" data-testid="deactivate-cases">
              {member.workload.map((w) => (
                <li key={w.projectId}>
                  <span className="font-medium">
                    {t('team.deactivateDialog.cases', {
                      count: w.open,
                      project: w.projectName,
                    })}
                  </span>
                  {' · '}
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: w.projectId }}
                    search={{ tab: 'cases' }}
                    className="font-medium text-indigo-ink-700 underline"
                  >
                    {t('team.deactivateDialog.openCases', { project: w.projectName })}
                  </Link>
                  {w.onDevice ? (
                    <p className="mt-0.5">
                      {t('team.deactivateDialog.onDevice', {
                        count: w.onDevice,
                        date: w.deviceSince ? dateTime(w.deviceSince) : '…',
                      })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2">{t('team.deactivateDialog.reassign')}</p>
          </div>
        ) : (
          <p className="text-slate-600">{t('team.deactivateDialog.noCases')}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('team.invite.cancel')}
          </Button>
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {t('team.deactivateDialog.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function StatusChip({ status }: { status: StatusFilter }) {
  const { t } = useTranslation();
  const tone =
    status === 'active'
      ? 'bg-emerald-50 text-emerald-ink-800'
      : status === 'invited'
        ? 'bg-indigo-50 text-indigo-ink-700'
        : status === 'awaiting'
          ? 'bg-amber-50 text-amber-ink-800'
          : 'bg-slate-100 text-slate-700';
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {status ? t(`team.status.${status}`) : ''}
    </span>
  );
}

/** One row per role: which role, and for the whole organisation or one project. */
function RolesEditor({
  value,
  onChange,
  grantable,
  projects,
}: {
  value: Grant[];
  onChange(v: Grant[]): void;
  grantable: readonly Role[];
  projects: ProjectRow[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const me = useMe();
  const canSeeMatrix = !!me.data?.permissions.includes('tenant.manage');
  // What each role may do here (an organisation can change it): a row whose permissions
  // another row already gives where it applies adds nothing.
  const view = useQuery({
    queryKey: ['tenant-roles', me.data?.tenantId],
    queryFn: () => api<RolesView>('/tenant/roles'),
    enabled: !!me.data,
    staleTime: 60_000,
  });
  const permissions = useMemo(
    () =>
      view.data
        ? Object.fromEntries(view.data.roles.map((r) => [r.role, r.permissions]))
        : undefined,
    [view.data],
  );
  const redundant = redundantRows(value, permissions);
  const scopeName = (p: string | null) =>
    p === null ? t('team.wholeOrg') : (projects.find((x) => x.id === p)?.name ?? '…');
  const set = (i: number, g: Partial<Grant>) =>
    onChange(value.map((x, j) => (j === i ? { ...x, ...g } : x)));
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-help`}>
      <legend className="text-sm font-medium text-slate-700">{t('team.roles.title')}</legend>
      <p id={`${id}-help`} className="text-sm text-slate-600">
        {t('team.roles.help')} {t('team.roles.rankNote')}
      </p>
      <RoleGuide roles={grantable} />
      {canSeeMatrix ? (
        <Link
          to="/admin/roles"
          target="_blank"
          className="text-sm font-medium text-indigo-ink-700 hover:underline"
        >
          {t('team.roles.allPermissions')}
        </Link>
      ) : null}
      {value.map((g, i) => (
        <div
          key={i}
          className="flex flex-wrap items-end gap-x-2 gap-y-1 rounded-md border border-slate-200 px-3 py-2"
          data-testid="role-row"
        >
          {/* A short label above each field; what the role does goes under the whole row. */}
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.roles.roleLabel')}</span>
            <select
              className={inputCls}
              value={g.role}
              aria-label={t('team.roles.role', { n: i + 1 })}
              aria-describedby={`${id}-hint-${i}`}
              onChange={(e) => set(i, { role: e.target.value as Role })}
            >
              {/* A role the person already has stays listed even above one's own rank. */}
              {ROLES.filter((r) => grantable.includes(r) || r === g.role).map((r) => (
                <option key={r} value={r} disabled={!grantable.includes(r)}>
                  {t(`team.roleNames.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.roles.scopeLabel')}</span>
            <select
              className={inputCls}
              value={g.projectId ?? ''}
              aria-label={t('team.roles.scope', { n: i + 1 })}
              onChange={(e) => set(i, { projectId: e.target.value || null })}
            >
              <option value="">{t('team.wholeOrg')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:border-red-600"
            aria-label={t('team.roles.remove', { n: i + 1 })}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </button>
          <p id={`${id}-hint-${i}`} className="basis-full text-xs text-slate-600">
            {t(`team.roleHints.${g.role}`)}
          </p>
          {redundant[i] != null ? (
            <p className="basis-full text-sm text-amber-ink-800" data-testid="redundant-row">
              {t('team.roles.redundant', {
                role: t(`team.roleNames.${value[redundant[i]]!.role}`),
                scope: scopeName(value[redundant[i]]!.projectId),
              })}
            </p>
          ) : null}
        </div>
      ))}
      {!value.length ? (
        <p className="text-sm text-amber-ink-800">{t('team.roles.noneWarning')}</p>
      ) : null}
      <div>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([
              ...value,
              {
                role: grantable.includes('interviewer') ? 'interviewer' : grantable[0]!,
                projectId: null,
              },
            ])
          }
        >
          {t('team.roles.add')}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * What the new roles open to someone of the client organisation (interviews, recordings,
 * personal data), by this organisation's permissions: the server asks for a reason then.
 */
function useExternalOpens(before: readonly Grant[], after: readonly Grant[]): string[] {
  const me = useMe();
  const view = useQuery({
    queryKey: ['tenant-roles', me.data?.tenantId],
    queryFn: () => api<RolesView>('/tenant/roles'),
    enabled: !!me.data,
    staleTime: 60_000,
  });
  if (!view.data) return [];
  const matrix = Object.fromEntries(view.data.roles.map((r) => [r.role, r.permissions]));
  return externalAccessOpened(before, after, matrix);
}

/** The warning and the reason asked before giving an external client such access. */
function ExternalReason({
  opens,
  reason,
  onReason,
}: {
  opens: readonly string[];
  reason: string;
  onReason(v: string): void;
}) {
  const { t } = useTranslation();
  if (!opens.length) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-ink-900"
      data-testid="external-warning"
    >
      <p className="font-medium">{t('team.projectPeople.externalWarning')}</p>
      <ul className="ml-5 list-disc">
        {opens.map((p) => (
          <li key={p}>{t(permKey(p))}</li>
        ))}
      </ul>
      <label className="flex flex-col gap-1 font-medium text-slate-800">
        {t('team.projectPeople.reason')}
        <textarea
          className={`${inputCls} min-h-[3rem] font-normal`}
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(e) => onReason(e.target.value)}
        />
      </label>
    </div>
  );
}

function InviteForm({
  grantable,
  projects,
  onCancel,
  onInvited,
  errorText,
}: {
  grantable: readonly Role[];
  projects: ProjectRow[];
  onCancel(): void;
  onInvited(email: string): Promise<void>;
  errorText(e: unknown): string;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [idCode, setIdCode] = useState('');
  const [grants, setGrants] = useState<Grant[]>([{ role: 'interviewer', projectId: null }]);
  const [reason, setReason] = useState('');
  const opens = useExternalOpens([], grants);
  const reasonOk = !opens.length || reason.trim().length >= 3;
  const invite = useMutation({
    mutationFn: () =>
      api('/users/invite', {
        method: 'POST',
        body: {
          email: email.trim(),
          name: name.trim(),
          ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
          ...(idCode.trim() ? { idCode: idCode.trim() } : {}),
          memberships: grants,
          ...(opens.length ? { reason: reason.trim() } : {}),
        },
      }),
    onSuccess: () => onInvited(email.trim()),
  });
  const ok =
    /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email.trim()) &&
    name.trim() &&
    grants.length &&
    reasonOk;
  return (
    <Dialog title={t('team.invite.title')} onClose={onCancel} wide>
      <form
        className="flex flex-col gap-4"
        aria-label={t('team.invite.title')}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) invite.mutate();
        }}
      >
        <p className="-mt-2 text-sm text-slate-600">{t('team.invite.help')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="invite-email"
            label={t('team.invite.email')}
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            id="invite-name"
            label={t('team.invite.name')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            id="invite-first"
            label={t('team.invite.firstName')}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
          <div>
            <Field
              id="invite-code"
              label={t('team.invite.idCode')}
              value={idCode}
              maxLength={50}
              aria-describedby="invite-code-help"
              onChange={(e) => setIdCode(e.target.value)}
            />
            <p id="invite-code-help" className="mt-1 text-xs text-slate-600">
              {t('team.invite.idCodeHelp')}
            </p>
          </div>
        </div>
        <RolesEditor
          value={grants}
          onChange={setGrants}
          grantable={grantable}
          projects={projects}
        />
        <ExternalReason opens={opens} reason={reason} onReason={setReason} />
        {invite.isError ? <ErrorText>{errorText(invite.error)}</ErrorText> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={!ok || invite.isPending}>
            {t('team.invite.send')}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('team.invite.cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RolesDialog({
  member,
  grantable,
  projects,
  onClose,
  onSaved,
  errorText,
}: {
  member: Member;
  grantable: readonly Role[];
  projects: ProjectRow[];
  onClose(): void;
  onSaved(): Promise<void>;
  errorText(e: unknown): string;
}) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<Grant[]>(member.memberships);
  const [reason, setReason] = useState('');
  const opens = useExternalOpens(member.memberships, grants);
  const save = useMutation({
    mutationFn: () =>
      api(`/users/${member.id}/memberships`, {
        method: 'PUT',
        body: { memberships: grants, ...(opens.length ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={t('team.roles.dialogTitle', { name: member.name })} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <RolesEditor
          value={grants}
          onChange={setGrants}
          grantable={grantable}
          projects={projects}
        />
        <ExternalReason opens={opens} reason={reason} onReason={setReason} />
        {save.isError ? <ErrorText>{errorText(save.error)}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('team.invite.cancel')}
          </Button>
          <Button
            type="button"
            disabled={opens.length > 0 && reason.trim().length < 3}
            busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('team.roles.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
