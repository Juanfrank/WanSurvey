import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { useMe } from './AppLayout.js';
import { Card } from './ui.js';

export function HomePage() {
  const { t } = useTranslation();
  const me = useMe();
  const projects = useQuery({
    queryKey: ['projects', me.data?.tenantId],
    queryFn: () => api<{ id: string; name: string; code: string; status: string }[]>('/projects'),
    enabled: !!me.data,
  });
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">
        {t('home.welcome', { name: me.data?.user.firstName ?? me.data?.user.name ?? '' })}
      </h1>
      <Card>
        <p className="mb-4 text-slate-700">{t('home.intro')}</p>
        <Link
          to="/preview"
          className="inline-block rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700"
        >
          {t('home.openPreview')}
        </Link>
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">{t('home.projects')}</h2>
        {projects.data?.length ? (
          <ul className="divide-y divide-slate-100">
            {projects.data.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <span>{p.name}</span>
                <span className="font-mono text-sm text-slate-500">
                  {p.code} · {p.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-600">{t('home.noProjects')}</p>
        )}
      </Card>
    </div>
  );
}
