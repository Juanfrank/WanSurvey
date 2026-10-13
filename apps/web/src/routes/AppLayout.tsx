import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, nextRouteFor, type Me } from '../api.js';
import { LANGUAGES, setLanguage } from '../i18n.js';

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
  const { t, i18n } = useTranslation();
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
    await api('/auth/switch-tenant', { method: 'POST', body: { tenantId } });
    await queryClient.invalidateQueries();
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    forgetCachedMe();
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  if (!me.data) return <main className="p-8 text-slate-500" aria-busy="true" />;
  const waiting = me.data.access.state === 'no_role';

  // Navy side panel on wide screens; below 900 px it becomes a top bar with pill tabs.
  const navLink =
    'flex-none rounded-full px-3 py-1.5 text-sm font-medium text-sidebar hover:bg-white/10 hover:text-white min-[900px]:rounded-lg min-[900px]:px-3 min-[900px]:py-2.5 [&.active]:bg-indigo-600 [&.active]:font-semibold [&.active]:text-white';
  const control =
    'w-full rounded-md border border-white/20 bg-white/10 px-2 py-1.5 text-sm text-white [&_option]:text-slate-800';
  return (
    <div className="min-h-screen min-[900px]:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        {t('app.skip')}
      </a>
      <header className="no-print bg-navy text-white min-[900px]:sticky min-[900px]:top-0 min-[900px]:h-screen min-[900px]:w-74 min-[900px]:flex-none min-[900px]:overflow-y-auto">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 min-[900px]:h-full min-[900px]:flex-col min-[900px]:flex-nowrap min-[900px]:items-stretch min-[900px]:gap-6 min-[900px]:px-4 min-[900px]:py-6">
          <Link
            to="/"
            className="px-1 text-lg font-bold uppercase tracking-wide text-white min-[900px]:px-3 min-[900px]:text-xl"
          >
            {t('app.name')}
          </Link>
          {!waiting ? (
            <nav
              aria-label="Main"
              className="flex min-w-0 gap-1 overflow-x-auto min-[900px]:flex-col min-[900px]:overflow-visible"
            >
              <Link to="/" className={navLink} activeOptions={{ exact: true }}>
                {t('app.home')}
              </Link>
              <Link to="/projects" className={navLink}>
                {t('app.projects')}
              </Link>
              <Link to="/preview" className={navLink}>
                {t('app.preview')}
              </Link>
            </nav>
          ) : null}
          <div className="flex w-full flex-wrap items-end gap-3 text-sm min-[900px]:mt-auto min-[900px]:flex-col min-[900px]:flex-nowrap min-[900px]:items-stretch min-[900px]:border-t min-[900px]:border-white/15 min-[900px]:pt-5">
            <label className="flex min-w-40 flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-sidebar">
                {t('app.organisation')}
              </span>
              <select
                className={control}
                value={me.data.tenantId}
                onChange={(e) => void switchTenant(e.target.value)}
              >
                {me.data.tenants.map((tn) => (
                  <option key={tn.id} value={tn.id}>
                    {tn.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-32 flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-sidebar">
                {t('app.language')}
              </span>
              <select
                className={control}
                value={i18n.resolvedLanguage}
                onChange={(e) => void setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex w-full min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sidebar" title={me.data.user.email}>
                {me.data.user.email}
              </span>
              <button
                type="button"
                className="flex-none rounded-md border border-white/25 px-3 py-1.5 font-semibold text-white hover:bg-white/10"
                onClick={() => void logout()}
              >
                {t('app.signOut')}
              </button>
            </div>
          </div>
        </div>
      </header>
      <main id="main" className="min-w-0 flex-1 px-4 py-6 min-[900px]:px-8 min-[900px]:py-7">
        <div className="mx-auto max-w-7xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
