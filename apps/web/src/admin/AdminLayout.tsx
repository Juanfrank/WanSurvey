import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../routes/AppLayout.js';
import { adminSectionsFor } from './sections.js';

/**
 * Administration: the people, teams, organisation settings and the activity log. The side
 * panel lists the sections; on narrow screens (no side panel list) they show as pills here.
 */
export function AdminLayout() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const sections = adminSectionsFor(me.data?.permissions);
  const first = sections[0]?.to;
  const atRoot = pathname.replace(/\/$/, '') === '/admin';
  useEffect(() => {
    if (me.data && atRoot) void navigate({ to: first ?? '/', replace: true });
  }, [me.data, atRoot, first, navigate]);

  return (
    <div className="flex flex-col gap-4">
      <nav
        aria-label={t('admin.nav')}
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 min-[900px]:hidden"
      >
        {sections.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="flex-none rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-medium text-slate-700 [&.active]:border-indigo-600 [&.active]:bg-indigo-600 [&.active]:text-on-fill"
          >
            {t(`admin.${s.key}`)}
          </Link>
        ))}
      </nav>
      {atRoot ? null : <Outlet />}
    </div>
  );
}
