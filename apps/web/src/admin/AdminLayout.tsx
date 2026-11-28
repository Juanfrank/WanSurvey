import { rolesRequiring2fa, type Role } from '@wansurvey/schema';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useMe } from '../routes/AppLayout.js';
import { MoreMenu } from '../routes/MoreMenu.js';
import { useOverflowFit } from '../routes/tabs.js';
import { Card, PageHeader } from '../routes/ui.js';
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

  const links = [
    { value: '/admin', label: t('admin.home.title') },
    ...pills.map((s) => ({ value: s.to, label: t(`admin.${s.key}`) })),
  ];
  const current = atRoot ? '/admin' : (pills.find((s) => pathname.startsWith(s.to))?.to ?? '');

  return (
    <div className="flex flex-col gap-4">
      <AdminPills links={links} current={current} />
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

const pillCls =
  'flex-none whitespace-nowrap rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-medium text-slate-700';
/** The gap between two pills (gap-2). */
const PILL_GAP = 8;

/**
 * The sections as pills on one line, on screens without the side panel's list. As the tabs of
 * a project (`OverflowTabList`), the ones that do not fit go in "More ▾"; the open one always
 * shows. Under 640 px the row scrolls sideways instead.
 */
function AdminPills({
  links,
  current,
}: {
  links: { value: string; label: string }[];
  current: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { room, measure, narrow, shown, hidden } = useOverflowFit(links, current, PILL_GAP);
  return (
    <nav aria-label={t('admin.nav')} className="min-[900px]:hidden">
      <div ref={room} className={`relative flex min-w-0 gap-2 ${narrow ? '-mx-4' : ''}`}>
        <div className={`flex min-w-0 gap-2 ${narrow ? 'overflow-x-auto px-4 pb-1' : ''}`}>
          {shown.map((x) => (
            <Link
              key={x.value}
              to={x.value}
              activeOptions={{ exact: x.value === '/admin' }}
              className={`${pillCls} [&.active]:border-indigo-600 [&.active]:bg-indigo-600 [&.active]:text-on-fill`}
            >
              {x.label}
            </Link>
          ))}
        </div>
        {hidden.length ? (
          <MoreMenu
            label={t('ui.moreSections')}
            unstyled
            className={`${pillCls} inline-flex items-center gap-1 hover:border-indigo-600 aria-expanded:border-indigo-600`}
            entries={hidden.map((x) => ({
              type: 'item' as const,
              id: x.value,
              label: x.label,
              onSelect: () => void navigate({ to: x.value }),
            }))}
          >
            {t('ui.more')}
            <span aria-hidden="true" className="text-xs">
              ▾
            </span>
          </MoreMenu>
        ) : null}
        {/* A copy of the row out of sight, to know how wide each pill is. */}
        <div
          ref={measure}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 flex h-0 w-max overflow-hidden"
        >
          {links.map((x) => (
            <span key={x.value} className={pillCls}>
              {x.label}
            </span>
          ))}
          <span className={`${pillCls} inline-flex items-center gap-1`}>
            {t('ui.more')}
            <span className="text-xs">▾</span>
          </span>
        </div>
      </div>
    </nav>
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

/** A count that needs attention and where it is dealt with (Users opens filtered). */
interface Tile {
  key: string;
  n: number;
  to: string;
  search?: { status?: string; twoStep?: string };
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
  const candidates: (Tile | false | undefined)[] = [
    people.data && {
      key: 'awaiting',
      n: members.filter((m) => m.awaitingRole).length,
      to: '/admin/users',
      search: { status: 'awaiting' },
    },
    people.data && {
      key: 'invited',
      n: members.filter((m) => m.status === 'invited').length,
      to: '/admin/users',
      search: { status: 'invited' },
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
        search: { twoStep: 'required' },
      },
    keys.data && {
      key: 'keysExpiring',
      n: keys.data.filter((k) => {
        const end = new Date(k.expiresAt).getTime();
        return !k.revokedAt && end > Date.now() && end <= soon;
      }).length,
      to: '/admin/api-keys',
    },
  ];
  const tiles = candidates.filter((x): x is Tile => !!x);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('app.admin')} />
      {tiles.length ? (
        <section aria-labelledby="admin-attention" className="flex flex-col gap-2">
          <h2 id="admin-attention" className="text-base font-semibold">
            {t('admin.home.attention')}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="admin-attention">
            {tiles.map((tile) => (
              <li key={tile.key} data-tile={tile.key} data-count={tile.n}>
                <Link
                  to={tile.to}
                  // Users opens with the matching filter on, so the list shows these people.
                  search={tile.search}
                  className="flex h-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-card hover:border-indigo-600"
                >
                  <span
                    className={`text-2xl font-bold tabular-nums ${tile.n ? 'text-amber-ink-800' : 'text-slate-700'}`}
                  >
                    {tile.n}
                  </span>
                  <span className="text-sm leading-snug text-slate-700">
                    {t(`admin.home.tiles.${tile.key}`, { count: tile.n, days: KEY_WARNING_DAYS })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ADMIN_GROUPS.map((group) => {
          const list = sections.filter((s) => s.group === group);
          return list.length ? (
            <Card key={group} className="p-4!">
              <h2 id={`admin-home-${group}`} className="mb-2 text-base font-semibold">
                {t(`admin.groups.${group}`)}
              </h2>
              <ul aria-labelledby={`admin-home-${group}`} className="flex flex-col gap-1.5">
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
