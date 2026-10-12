import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, nextRouteFor, type Me } from '../api.js';
import { LANGUAGES, setLanguage } from '../i18n.js';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
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
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  if (!me.data) return <main className="p-8 text-slate-500" aria-busy="true" />;
  const waiting = me.data.access.state === 'no_role';

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        {t('app.skip')}
      </a>
      <header className="no-print border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-bold tracking-tight text-indigo-700">
            {t('app.name')}
          </Link>
          {!waiting ? (
            <nav aria-label="Main" className="flex gap-4 text-sm">
              <Link
                to="/"
                className="hover:underline [&.active]:font-semibold"
                activeOptions={{ exact: true }}
              >
                {t('app.home')}
              </Link>
              <Link to="/projects" className="hover:underline [&.active]:font-semibold">
                {t('app.projects')}
              </Link>
              <Link to="/preview" className="hover:underline [&.active]:font-semibold">
                {t('app.preview')}
              </Link>
            </nav>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-slate-600">{t('app.organisation')}</span>
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1"
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
            <label className="flex items-center gap-2">
              <span className="text-slate-600">{t('app.language')}</span>
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1"
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
            <span className="text-slate-600">{me.data.user.email}</span>
            <button
              type="button"
              className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
              onClick={() => void logout()}
            >
              {t('app.signOut')}
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
