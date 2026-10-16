import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_RANK, ROLES, type Role } from '@wansurvey/schema';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { inputCls } from '../designer/fields.js';
import { below, Menu, type MenuEntry } from '../designer/Menu.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText, Field } from '../routes/ui.js';

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
}

interface ProjectRow {
  id: string;
  name: string;
}

type StatusFilter = '' | 'active' | 'invited' | 'deactivated' | 'awaiting';

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
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [menu, setMenu] = useState<{ m: Member; at: { x: number; y: number } } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grantable = ROLES.filter((r) => ROLE_RANK[r] <= myRank);
  const errorText = (e: unknown) =>
    e instanceof ApiError && e.status === 409
      ? t('team.errors.CONFLICT')
      : e instanceof ApiError && e.status === 403
        ? t('team.errors.FORBIDDEN')
        : t('team.errors.generic');
  const refresh = () => qc.invalidateQueries({ queryKey: ['team'] });
  const act = useMutation({
    mutationFn: async ({ m, action }: { m: Member; action: string }) => {
      await api(`/users/${m.id}/${action}`, { method: 'POST' });
      return { m, action };
    },
    onSuccess: async ({ m, action }) => {
      setError(null);
      setNotice(
        action === 'resend-invitation'
          ? t('team.done.resent', { email: m.email })
          : action === 'force-logout'
            ? t('team.done.logout', { name: m.name })
            : action === 'deactivate'
              ? t('team.done.deactivated', { name: m.name })
              : t('team.done.reactivated', { name: m.name }),
      );
      await refresh();
    },
    onError: (e) => {
      setNotice(null);
      setError(errorText(e));
    },
  });

  const statusOf = (m: Member): StatusFilter => (m.awaitingRole ? 'awaiting' : m.status);
  const q = query.trim().toLowerCase();
  const shown = (members.data ?? []).filter(
    (m) =>
      (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)) &&
      (!status || statusOf(m) === status),
  );
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
          onSelect: () => {
            if (window.confirm(t('team.confirmDeactivate', { name: m.name })))
              act.mutate({ m, action: 'deactivate' });
          },
        },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('team.title')}</h1>
        {canManage && !inviting ? (
          <Button onClick={() => setInviting(true)}>{t('team.invite.open')}</Button>
        ) : null}
      </div>
      <p className="-mt-3 max-w-3xl text-slate-600">
        {t('team.intro')} {canManage ? '' : t('team.readOnly')}
      </p>
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-ink-800"
        >
          {notice}
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
            setNotice(t('team.done.invited', { email }));
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{t('team.statusFilter')}</span>
            <select
              className={inputCls}
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
            >
              <option value="">{t('team.allStatuses')}</option>
              {(['active', 'invited', 'awaiting', 'deactivated'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`team.status.${s}`)} (
                  {(members.data ?? []).filter((m) => statusOf(m) === s).length})
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
                      <ul className="flex flex-col gap-0.5">
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
                        className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:border-indigo-600"
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
      {editing ? (
        <RolesDialog
          member={editing}
          grantable={grantable}
          projects={projects.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setNotice(t('team.done.roles', { name: editing.name }));
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
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
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
  const set = (i: number, g: Partial<Grant>) =>
    onChange(value.map((x, j) => (j === i ? { ...x, ...g } : x)));
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-help`}>
      <legend className="text-sm font-medium text-slate-700">{t('team.roles.title')}</legend>
      <p id={`${id}-help`} className="text-sm text-slate-600">
        {t('team.roles.help')} {t('team.roles.rankNote')}
      </p>
      {value.map((g, i) => (
        <div key={i} className="flex flex-wrap items-start gap-2" data-testid="role-row">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="sr-only">{t('team.roles.role', { n: i + 1 })}</span>
            <select
              className={inputCls}
              value={g.role}
              aria-label={t('team.roles.role', { n: i + 1 })}
              onChange={(e) => set(i, { role: e.target.value as Role })}
            >
              {/* A role the person already has stays listed even above one's own rank. */}
              {ROLES.filter((r) => grantable.includes(r) || r === g.role).map((r) => (
                <option key={r} value={r} disabled={!grantable.includes(r)}>
                  {t(`team.roleNames.${r}`)}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-600">{t(`team.roleHints.${g.role}`)}</span>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="sr-only">{t('team.roles.scope', { n: i + 1 })}</span>
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
            className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm hover:border-red-600"
            aria-label={t('team.roles.remove', { n: i + 1 })}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </button>
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
        },
      }),
    onSuccess: () => onInvited(email.trim()),
  });
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && name.trim() && grants.length;
  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        aria-label={t('team.invite.title')}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) invite.mutate();
        }}
      >
        <h2 className="text-lg font-semibold">{t('team.invite.title')}</h2>
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
    </Card>
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
  const save = useMutation({
    mutationFn: () =>
      api(`/users/${member.id}/memberships`, { method: 'PUT', body: { memberships: grants } }),
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
        {save.isError ? <ErrorText>{errorText(save.error)}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('team.invite.cancel')}
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('team.roles.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
