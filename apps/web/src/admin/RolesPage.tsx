import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SENSITIVE_PERMISSIONS, type Permission } from '@wansurvey/schema';
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { Dialog } from '../designer/Dialog.js';
import { smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText } from '../routes/ui.js';
import { PERMISSION_AREAS, permKey, type RolesView } from './permissions.js';

const isSensitive = (p: string) => SENSITIVE_PERMISSIONS.includes(p as Permission);

/** What the draft changes against what is saved: each role's given and taken permissions. */
export function draftChanges(
  saved: RolesView['roles'],
  draft: Record<string, string[]>,
): { role: string; given: string[]; taken: string[] }[] {
  return saved
    .filter((r) => r.editable)
    .map((r) => {
      const next = draft[r.role] ?? r.permissions;
      return {
        role: r.role,
        given: next.filter((p) => !r.permissions.includes(p)),
        taken: r.permissions.filter((p) => !next.includes(p)),
      };
    })
    .filter((c) => c.given.length || c.taken.length);
}

/**
 * What each role may do in the organisation: a matrix of permissions by role. Owners and
 * administrators keep everything; the other roles can be adjusted, and a role can go back to
 * its defaults.
 */
export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const view = useQuery({
    queryKey: ['tenant-roles', me.data?.tenantId],
    queryFn: () => api<RolesView>('/tenant/roles'),
    enabled: !!me.data,
  });
  const [draft, setDraft] = useState<Record<string, string[]> | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // How many people hold each role, for the confirmation (only for who may see the people).
  const people = useQuery({
    queryKey: ['team', me.data?.tenantId],
    queryFn: () => api<{ status: string; memberships: { role: string }[] }[]>('/users'),
    enabled: !!me.data?.permissions.includes('users.read'),
  });
  const holders = (role: string) =>
    people.data?.filter(
      (m) => m.status !== 'deactivated' && m.memberships.some((g) => g.role === role),
    ).length;
  useEffect(() => {
    if (view.data && !draft)
      setDraft(
        Object.fromEntries(
          view.data.roles.filter((r) => r.editable).map((r) => [r.role, r.permissions]),
        ),
      );
  }, [view.data, draft]);
  const save = useMutation({
    mutationFn: () =>
      api<RolesView>('/tenant/roles', { method: 'PUT', body: { overrides: draft ?? {} } }),
    onSuccess: async (next) => {
      qc.setQueryData(['tenant-roles', me.data?.tenantId], next);
      setDraft(
        Object.fromEntries(
          next.roles.filter((r) => r.editable).map((r) => [r.role, r.permissions]),
        ),
      );
      setSaved(true);
      setConfirming(false);
      // One's own permissions may have changed.
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const data = view.data;
  const changes = data && draft ? draftChanges(data.roles, draft) : [];
  const unsaved = changes.reduce((n, c) => n + c.given.length + c.taken.length, 0);
  const roleName = (r: string) => t(`team.roleNames.${r}`);
  const toggle = (role: string, p: string, on: boolean) => {
    setSaved(false);
    setDraft((d) => {
      const list = d?.[role] ?? [];
      return { ...d, [role]: on ? [...list, p] : list.filter((x) => x !== p) };
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('admin.roles')}</h1>
      <p className="-mt-3 max-w-3xl text-slate-600">{t('admin.rolesPage.intro')}</p>
      <p className="-mt-3 flex max-w-3xl items-start gap-2 text-sm text-slate-600">
        <SensitiveMark />
        {t('admin.rolesPage.sensitiveLegend')}
      </p>
      <Card className="overflow-x-auto">
        {data && draft ? (
          <table className="w-full min-w-[56rem] text-left text-sm" data-testid="roles-matrix">
            <thead>
              <tr className="border-b border-slate-200 align-bottom">
                <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t('admin.rolesPage.permission')}
                </th>
                {data.roles.map((r) => (
                  <th key={r.role} className="w-28 px-2 py-2 text-center">
                    <div className="font-semibold">{roleName(r.role)}</div>
                    {r.editable ? (
                      <button
                        type="button"
                        className="mt-1 text-xs font-medium text-indigo-ink-700 hover:underline disabled:invisible"
                        aria-label={t('admin.rolesPage.resetRole', { role: roleName(r.role) })}
                        disabled={
                          (draft[r.role] ?? []).length === r.defaults.length &&
                          r.defaults.every((p) => draft[r.role]?.includes(p))
                        }
                        onClick={() => {
                          setSaved(false);
                          setDraft({ ...draft, [r.role]: r.defaults });
                        }}
                      >
                        {t('admin.rolesPage.resetShort')}
                      </button>
                    ) : (
                      <div className="mt-1 text-xs text-slate-500">
                        {t('admin.rolesPage.fixed')}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_AREAS.map(({ area, permissions }) => (
                <Fragment key={area}>
                  <tr>
                    <th
                      colSpan={data.roles.length + 1}
                      scope="colgroup"
                      className="bg-slate-50 px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-600"
                    >
                      {t(`admin.permAreas.${area}`)}
                    </th>
                  </tr>
                  {permissions.map((p) => {
                    const reserved = data.reserved.includes(p);
                    return (
                      <tr key={p} className="border-b border-slate-100" data-permission={p}>
                        <th scope="row" className="min-w-[15rem] py-1.5 pr-4 font-normal">
                          <span className="inline-flex items-center gap-1.5">
                            {t(permKey(p))}
                            {isSensitive(p) ? <SensitiveMark /> : null}
                          </span>
                          {reserved ? (
                            <span className="block text-xs text-slate-500">
                              {t('admin.rolesPage.reserved')}
                            </span>
                          ) : null}
                        </th>
                        {data.roles.map((r) => {
                          const on = r.editable
                            ? !!draft[r.role]?.includes(p)
                            : r.permissions.includes(p);
                          const changed = r.editable && on !== r.defaults.includes(p);
                          // Every role sees its organisation; reserved ones stay with admins.
                          const locked = !r.editable || reserved || p === 'tenant.read';
                          return (
                            <td
                              key={r.role}
                              className={`p-0 text-center ${changed ? 'bg-amber-50' : ''}`}
                              title={changed ? t('admin.rolesPage.changed') : undefined}
                            >
                              {locked && !on ? (
                                <span className="text-slate-300">
                                  <span aria-hidden="true">—</span>
                                  <span className="sr-only">
                                    {t('admin.rolesPage.notApplicable')}
                                  </span>
                                </span>
                              ) : (
                                // The whole cell is the target, not only the 16 px box.
                                <label
                                  className={`flex min-h-10 min-w-10 items-center justify-center px-2 py-1.5 ${locked ? '' : 'cursor-pointer hover:bg-indigo-50'}`}
                                >
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={on}
                                    disabled={locked}
                                    aria-label={`${t('admin.rolesPage.allow', {
                                      role: roleName(r.role),
                                      permission: t(permKey(p)),
                                    })}${changed ? ` (${t('admin.rolesPage.changedShort')})` : ''}`}
                                    onChange={(e) => toggle(r.role, p, e.target.checked)}
                                  />
                                </label>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <div aria-busy="true" className="h-40" />
        )}
      </Card>
      {save.isError && !confirming ? <ErrorText>{t('admin.rolesPage.error')}</ErrorText> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!draft || save.isPending}
          onClick={() => {
            setSaved(false);
            save.reset();
            setConfirming(true);
          }}
        >
          {t('admin.rolesPage.save')}
        </Button>
        {unsaved ? (
          <span className="text-sm font-medium text-amber-ink-800" data-testid="roles-unsaved">
            {t('admin.rolesPage.unsaved', { count: unsaved })}
          </span>
        ) : null}
        <button
          type="button"
          className={smallBtn}
          disabled={!data}
          onClick={() => {
            setSaved(false);
            setDraft(
              Object.fromEntries(
                (data?.roles ?? []).filter((r) => r.editable).map((r) => [r.role, r.defaults]),
              ),
            );
          }}
        >
          {t('admin.rolesPage.reset')}
        </button>
        <p role="status" className="text-sm text-emerald-ink-800 empty:hidden">
          {saved ? t('admin.rolesPage.saved') : null}
        </p>
      </div>
      {confirming ? (
        <Dialog title={t('admin.rolesPage.confirmTitle')} onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-4" data-testid="roles-confirm">
            {changes.length ? (
              <>
                <p className="text-sm text-slate-700">{t('admin.rolesPage.confirmIntro')}</p>
                {changes.map((c) => {
                  const n = holders(c.role);
                  return (
                    <section key={c.role} data-role={c.role} className="flex flex-col gap-1">
                      <h3 className="font-semibold">{roleName(c.role)}</h3>
                      {n === undefined ? null : (
                        <p className="text-xs text-slate-600">
                          {t('admin.rolesPage.people', { count: n })}
                        </p>
                      )}
                      <ul className="flex flex-col gap-1 text-sm">
                        {c.given.map((p) => (
                          <li key={p} data-given={p}>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="font-medium text-emerald-ink-800">
                                + {t('admin.rolesPage.given')}:
                              </span>
                              {t(permKey(p))}
                              {isSensitive(p) ? <SensitiveMark /> : null}
                            </span>
                            {isSensitive(p) ? (
                              <span className="block text-xs text-amber-ink-800">
                                {c.role === 'client_viewer' && p === 'pii.view'
                                  ? t('admin.rolesPage.clientPii')
                                  : t('admin.rolesPage.sensitiveGiven')}
                              </span>
                            ) : null}
                          </li>
                        ))}
                        {c.taken.map((p) => (
                          <li key={p} data-taken={p}>
                            <span className="font-medium text-red-ink-800">
                              − {t('admin.rolesPage.taken')}:
                            </span>{' '}
                            {t(permKey(p))}
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </>
            ) : (
              <p className="text-sm text-slate-700">{t('admin.rolesPage.nothing')}</p>
            )}
            {save.isError ? <ErrorText>{t('admin.rolesPage.error')}</ErrorText> : null}
            <div className="flex gap-3">
              {changes.length ? (
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  {t('admin.rolesPage.confirm')}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {t('admin.rolesPage.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The mark of a sensitive permission: an icon with its name for screen readers. */
function SensitiveMark() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex flex-none items-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-ink-900"
      title={t('admin.rolesPage.sensitive')}
    >
      <span aria-hidden="true">!</span>
      <span className="sr-only">{t('admin.rolesPage.sensitive')}</span>
    </span>
  );
}
