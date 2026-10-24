import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, nextRouteFor, switchTenant as openTenant, type Me } from '../api.js';
import { AccountMenu } from './AccountMenu.js';
import { adminSectionsFor } from '../admin/sections.js';
import { CogIcon, FolderIcon, HomeIcon, MenuIcon } from './icons.js';
import { LogoMark, LogoName } from './Logo.js';
import { useMedia, useStoredFlag } from './SideDrawer.js';

const ME_KEY = 'wansurvey.me';

/**
 * The signed-in person. The last answer is kept on the device so the app still opens with no
 * connection (offline interviewing); the server decides again as soon as it is reachable.
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api<Me>('/auth/me');
        try {
          localStorage.setItem(ME_KEY, JSON.stringify(me));
        } catch {
          // Storage may be unavailable; the app still works online.
        }
        return me;
      } catch (e) {
        const cached = !(e instanceof ApiError) ? readCachedMe() : null;
        if (cached) return cached;
        throw e;
      }
    },
  });
}

function readCachedMe(): Me | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export function forgetCachedMe() {
  try {
    localStorage.removeItem(ME_KEY);
  } catch {
    // Nothing kept.
  }
}

/** Signed-in area: organisation switcher, language, sign out. Sends people where their session needs them. */
export function AppLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const me = useMe();

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) void navigate({ to: '/login' });
    if (me.data) {
      const target = nextRouteFor(me.data);
      if (target && target !== location.pathname) void navigate({ to: target });
      if (!target && location.pathname === '/waiting') void navigate({ to: '/' });
    }
  }, [me.data, me.error, location.pathname, navigate]);

  const switchTenant = async (tenantId: string) => {
    if (await openTenant(tenantId)) await queryClient.invalidateQueries();
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    forgetCachedMe();
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  if (!me.data) return <main className="p-8 text-slate-500" aria-busy="true" />;
  const waiting = me.data.access.state === 'no_role';

  return (
    <div className="min-h-screen min-[900px]:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        {t('app.skip')}
      </a>
      <SidePanel waiting={waiting} />
      <main
        id="main"
        className="min-w-0 flex-1 px-4 py-4 min-[900px]:py-5 min-[900px]:pl-[calc(var(--pane-left,0px)+2rem)] min-[900px]:pr-[calc(var(--pane-right,0px)+2rem)]"
      >
        {/* Up to 1600 px: wide screens are used; on very wide ones lines do not drift apart. */}
        <div className="relative mx-auto flex max-w-[100rem] flex-col">
          {/* Beside the first line of the page on wide screens, so it takes no row of its own. */}
          <div className="no-print mb-3 flex justify-end min-[900px]:absolute min-[900px]:right-0 min-[900px]:top-0 min-[900px]:z-10 min-[900px]:mb-0">
            <AccountMenu
              me={me.data}
              onSwitchTenant={(id) => void switchTenant(id)}
              onSignOut={() => void logout()}
            />
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** Wide screens with no saved choice start compact on small laptops and tablets. */
const COMPACT_UP_TO = '(max-width: 1180px)';

/**
 * The navy side panel. On wide screens it is pinned open (296 px) or compact (a 72 px rail of
 * icons that opens over the content while the pointer or keyboard focus is on it); the burger
 * switches between the two and the choice is remembered. Below 900 px it is a top bar with
 * the pages as pill tabs.
 */
function SidePanel({ waiting }: { waiting: boolean }) {
  const { t } = useTranslation();
  const me = useMe();
  const admin = adminSectionsFor(me.data?.permissions);
  const { pathname } = useLocation();
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string; status: string }[]>('/projects'),
    enabled: !!me.data && !waiting,
  });
  const wide = useMedia('(min-width: 900px)');
  const small = useMedia(COMPACT_UP_TO);
  const [compact, setCompact] = useStoredFlag('ws.sidebar.compact', small);
  const [over, setOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const isCompact = wide && compact;
  const rail = isCompact && !over && !focused;
  // The width the panel keeps for itself, so side panes can sit right against it.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      '--side-w',
      !wide ? '0px' : isCompact ? '72px' : '296px',
    );
  }, [wide, isCompact]);

  // With the panel open, a section's pages are listed under it: the section itself is marked
  // only on its own page, and in a lighter way while one of its pages is open.
  const nested = wide && !rail;
  const link = (to: string, label: string, icon: ReactNode, exact = false) => {
    const within = to !== '/' && pathname.startsWith(to) && pathname !== to;
    return (
      <Link
        to={to}
        activeOptions={exact || (nested && to !== '/') ? { exact: true } : undefined}
        title={rail ? label : undefined}
        className={`flex flex-none items-center gap-3 rounded-full border border-on-fill/20 px-3.5 py-1.5 text-sm font-medium text-sidebar hover:bg-on-fill/10 hover:text-on-fill min-[900px]:rounded-lg min-[900px]:border-0 min-[900px]:py-2.5 [&.active]:border-indigo-600 [&.active]:bg-indigo-600 [&.active]:font-semibold [&.active]:text-on-fill ${
          rail
            ? 'min-[900px]:h-10 min-[900px]:w-10 min-[900px]:justify-center min-[900px]:px-0'
            : ''
        } ${nested && within ? 'font-semibold text-on-fill' : ''}`}
      >
        <span className="hidden min-[900px]:inline">{icon}</span>
        <span className={rail ? 'sr-only' : 'truncate'}>{label}</span>
      </Link>
    );
  };
  const subCls =
    'block truncate rounded-md px-2.5 py-1.5 text-sm text-sidebar hover:bg-on-fill/10 hover:text-on-fill [&.active]:bg-on-fill/15 [&.active]:font-semibold [&.active]:text-on-fill';
  const shownProjects = (projects.data ?? []).filter((p) => p.status !== 'archived');
  const MAX_PROJECTS = 8;

  return (
    <header
      className={`no-print relative z-30 flex-none bg-navy-fill text-on-fill min-[900px]:transition-[width] min-[900px]:duration-200 ${
        isCompact ? 'min-[900px]:w-18' : 'min-[900px]:w-74'
      }`}
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
      onFocus={(e) => setFocused(e.target.matches(':focus-visible'))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div
        className={`flex flex-col gap-3 bg-navy-fill px-4 py-3 min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-screen min-[900px]:gap-6 min-[900px]:overflow-y-auto min-[900px]:overflow-x-hidden min-[900px]:py-6 min-[900px]:transition-[width] min-[900px]:duration-200 ${
          rail ? 'min-[900px]:w-18 min-[900px]:items-center min-[900px]:px-4' : 'min-[900px]:w-74'
        } ${isCompact && !rail ? 'min-[900px]:shadow-card' : ''}`}
      >
        <div className={`flex items-center gap-2 ${rail ? 'min-[900px]:flex-col' : ''}`}>
          <Link
            to="/"
            aria-label={t('app.name')}
            className={`flex min-w-0 flex-1 items-center gap-2.5 px-1 min-[900px]:px-3 ${
              rail ? 'min-[900px]:flex-none min-[900px]:px-0' : ''
            }`}
          >
            <LogoMark onFill className="h-8 w-8 flex-none min-[900px]:h-9 min-[900px]:w-9" />
            <LogoName
              onFill
              className={`truncate text-lg min-[900px]:text-xl ${rail ? 'min-[900px]:sr-only' : ''}`}
            />
          </Link>
          {wide ? (
            <button
              type="button"
              aria-pressed={!compact}
              aria-label={compact ? t('app.expandPanel') : t('app.compactPanel')}
              title={compact ? t('app.expandPanel') : t('app.compactPanel')}
              onClick={() => {
                setCompact(!compact);
                setOver(false);
              }}
              className={`grid h-10 w-10 flex-none place-items-center rounded-lg text-on-fill ${
                compact
                  ? 'bg-on-fill/10 hover:bg-on-fill/20'
                  : 'bg-indigo-600 shadow-[0_0_0_2px_rgb(255_255_255/0.28)] hover:bg-indigo-500'
              }`}
            >
              <MenuIcon className="h-5 w-5" />
            </button>
          ) : null}
        </div>
        {!waiting ? (
          <nav
            aria-label={t('app.mainNav')}
            className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 pb-1 min-[900px]:mx-0 min-[900px]:flex-col min-[900px]:gap-1 min-[900px]:overflow-visible min-[900px]:px-0"
          >
            {link('/', t('app.home'), <HomeIcon />, true)}
            {link('/projects', t('app.projects'), <FolderIcon />)}
            {nested && shownProjects.length ? (
              <ul
                aria-label={t('app.projects')}
                className="mb-1 ml-[1.375rem] flex flex-col gap-0.5 border-l border-on-fill/15 pl-3"
              >
                {shownProjects.slice(0, MAX_PROJECTS).map((p) => (
                  <li key={p.id}>
                    <Link to="/projects/$projectId" params={{ projectId: p.id }} className={subCls}>
                      {p.name}
                    </Link>
                  </li>
                ))}
                {shownProjects.length > MAX_PROJECTS ? (
                  <li>
                    <Link
                      to="/projects"
                      activeOptions={{ exact: true }}
                      className={`${subCls} italic`}
                    >
                      {t('app.allProjects')}
                    </Link>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {admin.length ? link('/admin', t('app.admin'), <CogIcon />) : null}
            {nested && admin.length ? (
              <ul
                aria-label={t('app.admin')}
                className="ml-[1.375rem] flex flex-col gap-0.5 border-l border-on-fill/15 pl-3"
              >
                {admin.map((a) => (
                  <li key={a.to}>
                    <Link to={a.to} className={subCls}>
                      {t(`admin.${a.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
