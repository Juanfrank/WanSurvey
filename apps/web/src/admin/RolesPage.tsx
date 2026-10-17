import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { smallBtn } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import { Button, Card, ErrorText } from '../routes/ui.js';
import { PERMISSION_AREAS, permKey, type RolesView } from './permissions.js';

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
      // One's own permissions may have changed.
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const data = view.data;
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
                          {t(permKey(p))}
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
                              className={`px-2 py-1.5 text-center ${changed ? 'bg-amber-50' : ''}`}
                              title={changed ? t('admin.rolesPage.changed') : undefined}
                            >
                              {locked && !on ? (
                                <span aria-hidden="true" className="text-slate-300">
                                  —
                                </span>
                              ) : (
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  checked={on}
                                  disabled={locked}
                                  aria-label={t('admin.rolesPage.allow', {
                                    role: roleName(r.role),
                                    permission: t(permKey(p)),
                                  })}
                                  onChange={(e) => toggle(r.role, p, e.target.checked)}
                                />
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
      {save.isError ? <ErrorText>{t('admin.rolesPage.error')}</ErrorText> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>
          {t('admin.rolesPage.save')}
        </Button>
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
        {saved ? (
          <p role="status" className="text-sm text-emerald-ink-800">
            {t('admin.rolesPage.saved')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
