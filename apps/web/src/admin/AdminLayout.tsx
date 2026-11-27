import { rolesRequiring2fa, type Role } from '@wansurvey/schema';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useMe } from '../routes/AppLayout.js';
import { Card } from '../routes/ui.js';
import { ADMIN_GROUPS, adminMenuFor, adminSectionsFor } from './sections.js';

/**
 * Administration: the people, teams, organisation settings and the activity log. The side
 * panel lists the sections; on narrow screens (no side panel list) they show as pills here.
 * `/admin` itself is an overview: what needs attention, then every section by block.
 */
export function AdminLayout() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const permissions = me.data?.permissions;
  const open = adminSectionsFor(permissions);
  const menu = adminMenuFor(permissions);
  // A section reached by its address stays among the pills while it is open.
  const pills = open.filter((s) => menu.includes(s) || pathname.startsWith(s.to));
  const atRoot = pathname.replace(/\/$/, '') === '/admin';
  const nothing = !!me.data && open.length === 0;
  useEffect(() => {
    if (nothing) void navigate({ to: '/', replace: true });
  }, [nothing, navigate]);

  return (
    <div className="flex flex-col gap-4">
      <nav
        aria-label={t('admin.nav')}
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 min-[900px]:hidden"
      >
        <Link
          to="/admin"
          activeOptions={{ exact: true }}
          className="flex-none rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-medium text-slate-700 [&.active]:border-indigo-600 [&.active]:bg-indigo-600 [&.active]:text-on-fill"
        >
          {t('admin.home.title')}
        </Link>
        {pills.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="flex-none rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-medium text-slate-700 [&.active]:border-indigo-600 [&.active]:bg-indigo-600 [&.active]:text-on-fill"
          >
            {t(`admin.${s.key}`)}
          </Link>
        ))}
      </nav>
      {atRoot ? (
        me.data && !nothing ? (
          <AdminHome permissions={permissions ?? []} />
        ) : null
      ) : (
        <Outlet />
      )}
    </div>
  );
}

interface MemberRow {
  status: 'active' | 'invited' | 'deactivated';
  totpEnabled: boolean;
  awaitingRole: boolean;
  memberships: { role: string }[];
}

interface KeyRow {
  expiresAt: string;
  revokedAt: string | null;
}

/** Keys that end within this many days are pointed out. */
const KEY_WARNING_DAYS = 15;

/** What needs an administrator's attention, each with a link to where it is dealt with. */
function AdminHome({ permissions }: { permissions: readonly string[] }) {
  const { t } = useTranslation();
  const me = useMe();
  const tenantId = me.data?.tenantId;
  const sections = adminSectionsFor(permissions);
  const can = (p: string) => permissions.includes(p);
  const people = useQuery({
    queryKey: ['team', tenantId],
    queryFn: () => api<MemberRow[]>('/users'),
    enabled: can('users.read'),
  });
  const tenant = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => api<{ settings?: unknown }>('/tenant'),
    enabled: can('users.read'),
  });
  const keys = useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => api<KeyRow[]>('/api-keys'),
    enabled: can('apikeys.manage') || can('audit.read'),
  });
  const required: Role[] = rolesRequiring2fa(tenant.data?.settings);
  const members = (people.data ?? []).filter((m) => m.status !== 'deactivated');
  const soon = Date.now() + KEY_WARNING_DAYS * 86_400_000;
  const tiles = [
    people.data && {
      key: 'awaiting',
      n: members.filter((m) => m.awaitingRole).length,
      to: '/admin/users',
    },
    people.data && {
      key: 'invited',
      n: members.filter((m) => m.status === 'invited').length,
      to: '/admin/users',
    },
    people.data &&
      tenant.data && {
        key: 'without2fa',
        n: members.filter(
          (m) =>
            m.status === 'active' &&
            !m.totpEnabled &&
            m.memberships.some((g) => required.includes(g.role as Role)),
        ).length,
        to: '/admin/users',
      },
    keys.data && {
      key: 'keysExpiring',
      n: keys.data.filter((k) => {
        const end = new Date(k.expiresAt).getTime();
        return !k.revokedAt && end > Date.now() && end <= soon;
      }).length,
      to: '/admin/api-keys',
    },
  ].filter((x): x is { key: string; n: number; to: string } => !!x);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t('app.admin')}</h1>
      {tiles.length ? (
        <section aria-labelledby="admin-attention" className="flex flex-col gap-3">
          <h2 id="admin-attention" className="text-lg font-semibold">
            {t('admin.home.attention')}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="admin-attention">
            {tiles.map((tile) => (
              <li key={tile.key} data-tile={tile.key} data-count={tile.n}>
                <Link
                  to={tile.to}
                  className="flex h-full flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 shadow-card hover:border-indigo-600"
                >
                  <span
                    className={`text-3xl font-bold ${tile.n ? 'text-amber-ink-800' : 'text-slate-700'}`}
                  >
                    {tile.n}
                  </span>
                  <span className="text-sm text-slate-700">
                    {t(`admin.home.tiles.${tile.key}`, { count: tile.n, days: KEY_WARNING_DAYS })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {ADMIN_GROUPS.map((group) => {
          const list = sections.filter((s) => s.group === group);
          return list.length ? (
            <Card key={group}>
              <h2 id={`admin-home-${group}`} className="mb-3 text-lg font-semibold">
                {t(`admin.groups.${group}`)}
              </h2>
              <ul aria-labelledby={`admin-home-${group}`} className="flex flex-col gap-2">
                {list.map((s) => (
                  <li key={s.to}>
                    <Link to={s.to} className="font-medium text-indigo-ink-700 hover:underline">
                      {t(`admin.${s.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null;
        })}
      </div>
    </div>
  );
}
