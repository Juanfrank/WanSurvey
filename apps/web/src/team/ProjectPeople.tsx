import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Role } from '@wansurvey/schema';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { FoldedHelp, inputCls } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, Drawer, ErrorText, MoreMenu, type MenuEntry } from '../routes/ui.js';
import { ExternalReason } from './ExternalReason.js';
import { RoleGuide } from './RoleGuide.js';

interface People {
  members: {
    userId: string;
    name: string;
    email: string;
    status: string;
    role: Role;
    orgRole: Role | null;
  }[];
  candidates: { id: string; name: string; email: string; external?: boolean }[];
  grantable: Role[];
  /** For each role that can be given, what it opens to interviews, recordings or personal data. */
  sensitive?: Partial<Record<Role, string[]>>;
  canManage: boolean;
}

/**
 * The people of one project and their role in it. Administrators and the project's manager
 * change them (the server says which roles each may give); others only look.
 */
export function ProjectPeople({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const people = useQuery({
    queryKey: ['project-people', projectId],
    queryFn: () => api<People>(`/projects/${projectId}/people`),
  });
  const [editing, setEditing] = useState<{ userId?: string; role?: Role } | null>(null);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  // Kept as keys, so the message follows a change of language.
  const [notice, setNotice] = useState<{ key: string; name: string; role?: Role } | null>(null);
  const save = useMutation({
    mutationFn: (v: { userId: string; role: Role | null; reason?: string }) =>
      api(`/projects/${projectId}/people/${v.userId}`, {
        method: 'PUT',
        body: { role: v.role, ...(v.reason ? { reason: v.reason } : {}) },
      }),
    onSuccess: async (_r, v) => {
      const name =
        people.data?.candidates.find((c) => c.id === v.userId)?.name ??
        people.data?.members.find((m) => m.userId === v.userId)?.name ??
        '';
      setEditing(null);
      setRemoving(null);
      setNotice(
        v.role
          ? { key: 'team.projectPeople.saved', name, role: v.role }
          : { key: 'team.projectPeople.removed', name },
      );
      await qc.invalidateQueries({ queryKey: ['project-people', projectId] });
    },
    // A refused removal is shown on the page, under the closed dialog.
    onError: () => setRemoving(null),
  });
  const data = people.data;
  const canInvite = !!me.data?.permissions.includes('users.manage');
  const roleName = (r: Role) => t(`team.roleNames.${r}`);
  const errorText = (e: unknown) =>
    e instanceof ApiError && e.status === 403
      ? t('team.errors.FORBIDDEN')
      : e instanceof ApiError && e.code === 'REASON_REQUIRED'
        ? t('team.projectPeople.reasonRequired')
        : t('team.errors.generic');

  const entriesFor = (m: People['members'][number]): MenuEntry[] => [
    {
      type: 'item',
      id: 'change',
      label: t('team.projectPeople.change', { name: m.name }),
      onSelect: () => setEditing({ userId: m.userId, role: m.role }),
    },
    {
      type: 'item',
      id: 'remove',
      label: t('team.projectPeople.remove', { name: m.name }),
      disabled: save.isPending,
      onSelect: () => setRemoving({ userId: m.userId, name: m.name }),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-lg font-semibold">{t('team.projectPeople.title')}</h2>
        {canInvite ? (
          <Link
            to="/admin/users"
            className="text-sm font-medium text-indigo-ink-700 hover:underline"
          >
            {t('team.projectPeople.invite')}
          </Link>
        ) : null}
        {data?.canManage ? (
          <Button className="ml-auto" aria-haspopup="dialog" onClick={() => setEditing({})}>
            + {t('team.projectPeople.add')}
          </Button>
        ) : null}
      </div>
      {data && !data.canManage ? (
        <p className="-mt-2 text-sm text-slate-700">{t('team.projectPeople.readOnly')}</p>
      ) : null}
      <FoldedHelp className="-mt-2 max-w-3xl">{t('team.projectPeople.intro')}</FoldedHelp>
      <RoleGuide />
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-ink-800"
        >
          {t(notice.key, { name: notice.name, role: notice.role ? roleName(notice.role) : '' })}
        </p>
      ) : null}
      {save.isError && !editing ? <ErrorText>{errorText(save.error)}</ErrorText> : null}
      <Card className="overflow-x-auto p-4">
        {data && !data.members.length ? (
          <p className="text-slate-600">{t('team.projectPeople.none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" aria-busy={people.isLoading}>
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr className="whitespace-nowrap">
                  <th className="py-2 pr-4 font-semibold">{t('team.projectPeople.person')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('team.projectPeople.role')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('team.projectPeople.orgRole')}</th>
                  {data?.canManage ? (
                    <th className="py-2 font-semibold">
                      <span className="sr-only">{t('team.projectPeople.actions')}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {(data?.members ?? []).map((m) => {
                  const mine = data!.grantable.includes(m.role) && m.userId !== me.data?.user.id;
                  return (
                    <tr
                      key={m.userId}
                      data-person={m.email}
                      className="border-b border-slate-100 whitespace-nowrap"
                    >
                      <td className="py-1.5 pr-4">
                        <span className="font-medium">{m.name}</span>{' '}
                        <span className="text-xs text-slate-600">{m.email}</span>
                      </td>
                      <td className="py-1.5 pr-4">
                        <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-ink-700">
                          {roleName(m.role)}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 text-xs text-slate-600">
                        {m.orgRole ? roleName(m.orgRole) : '—'}
                      </td>
                      {data?.canManage ? (
                        <td className="py-1 text-right">
                          {mine ? (
                            <MoreMenu
                              label={t('team.projectPeople.rowActions', { name: m.name })}
                              entries={entriesFor(m)}
                            />
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {removing ? (
        <Dialog
          title={t('team.projectPeople.removeTitle', { name: removing.name })}
          onClose={() => setRemoving(null)}
        >
          <p className="mb-4 text-sm text-slate-700">{t('team.projectPeople.removeBody')}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>
              {t('team.projectPeople.cancel')}
            </Button>
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate({ userId: removing.userId, role: null })}
            >
              {t('team.projectPeople.removeShort')}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {editing && data ? (
        <PersonDialog
          people={data}
          meId={me.data?.user.id}
          initial={editing}
          pending={save.isPending}
          error={save.isError ? errorText(save.error) : null}
          onClose={() => {
            save.reset();
            setEditing(null);
          }}
          onSave={(userId, role, reason) => save.mutate({ userId, role, reason })}
        />
      ) : null}
    </div>
  );
}

function PersonDialog({
  people,
  meId,
  initial,
  pending,
  error,
  onClose,
  onSave,
}: {
  people: People;
  meId: string | undefined;
  initial: { userId?: string; role?: Role };
  pending: boolean;
  error: string | null;
  onClose(): void;
  onSave(userId: string, role: Role, reason?: string): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [userId, setUserId] = useState(initial.userId ?? '');
  const [role, setRole] = useState<Role>(
    initial.role ??
      (people.grantable.includes('interviewer') ? 'interviewer' : people.grantable[0]!),
  );
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  const editing = !!initial.userId;
  const person = people.members.find((m) => m.userId === userId);
  // Someone of the client organisation given access to interviews, recordings or personal
  // data: the dialog says what they will see and asks why (kept in the activity log).
  const external = !!people.candidates.find((c) => c.id === userId)?.external;
  const opens = external ? (people.sensitive?.[role] ?? []) : [];
  const needsReason = opens.length > 0;
  const choices = useMemo(() => {
    const inProject = new Set(people.members.map((m) => m.userId));
    const q = query.trim().toLowerCase();
    return people.candidates.filter(
      (c) =>
        c.id !== meId &&
        !inProject.has(c.id) &&
        (!q || `${c.name} ${c.email}`.toLowerCase().includes(q)),
    );
  }, [people, meId, query]);
  return (
    <Drawer
      title={
        editing
          ? t('team.projectPeople.change', { name: person?.name ?? '' })
          : t('team.projectPeople.add')
      }
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('team.projectPeople.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!userId || pending || (needsReason && reason.trim().length < 3)}
          >
            {t('team.projectPeople.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (userId && (!needsReason || reason.trim().length >= 3))
            onSave(userId, role, needsReason ? reason.trim() : undefined);
        }}
      >
        {editing ? null : (
          <div className="flex flex-col gap-1">
            <label htmlFor="pp-person" className="text-sm font-medium text-slate-700">
              {t('team.projectPeople.choose')}
            </label>
            <input
              type="search"
              aria-label={t('team.projectPeople.search')}
              placeholder={t('team.projectPeople.search')}
              className={inputCls}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              id="pp-person"
              className={`${inputCls} py-2`}
              value={userId}
              required
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">{t('team.projectPeople.choosePlaceholder')}</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.email}
                </option>
              ))}
            </select>
          </div>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-slate-700">
            {t('team.projectPeople.role')}
          </legend>
          {people.grantable.map((r) => (
            <label
              key={r}
              className="flex items-start gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50"
            >
              <input
                type="radio"
                name="pp-role"
                className="mt-0.5"
                checked={role === r}
                onChange={() => setRole(r)}
              />
              <span>
                <span className="font-medium">{t(`team.roleNames.${r}`)}</span>
                <span className="block text-xs text-slate-600">{t(`team.roleHints.${r}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <ExternalReason opens={opens} reason={reason} onReason={setReason} />
        <RoleGuide roles={people.grantable} />
        {error ? <ErrorText>{error}</ErrorText> : null}
      </form>
    </Drawer>
  );
}
