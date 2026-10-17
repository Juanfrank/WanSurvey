import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { PERMISSION_AREAS, permKey, type RolesView } from '../admin/permissions.js';
import { useMe } from '../routes/AppLayout.js';

/** Shown for every role anyway: not worth listing. */
const OBVIOUS = new Set(['tenant.read', 'projects.read']);
const ORDER = PERMISSION_AREAS.flatMap((a) => a.permissions as string[]);

/**
 * What each role may do, as this organisation has it (permissions can be customised), for the
 * places where roles are given. Folded by default.
 */
export function RoleGuide({ roles, open = false }: { roles?: readonly string[]; open?: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const view = useQuery({
    queryKey: ['tenant-roles', me.data?.tenantId],
    queryFn: () => api<RolesView>('/tenant/roles'),
    enabled: !!me.data,
    staleTime: 60_000,
  });
  const shown = (view.data?.roles ?? []).filter((r) => !roles || roles.includes(r.role));
  if (!shown.length) return null;
  return (
    <details
      open={open}
      className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm"
      data-testid="role-guide"
    >
      <summary className="cursor-pointer py-1 font-medium text-indigo-ink-700">
        {t('admin.guide.title')}
      </summary>
      <dl className="mt-2 grid gap-3 pb-2 md:grid-cols-2">
        {shown.map((r) => {
          const list = ORDER.filter((p) => r.permissions.includes(p) && !OBVIOUS.has(p));
          return (
            <div key={r.role} data-role={r.role}>
              <dt className="font-semibold text-slate-800">{t(`team.roleNames.${r.role}`)}</dt>
              <dd className="text-xs text-slate-600">
                <p>{t(`team.roleHints.${r.role}`)}</p>
                {!r.editable ? (
                  <p className="mt-1">{t('admin.guide.all')}</p>
                ) : list.length ? (
                  <ul className="mt-1 list-disc pl-4">
                    {list.map((p) => (
                      <li key={p}>{t(permKey(p))}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1">{t('admin.guide.none')}</p>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
