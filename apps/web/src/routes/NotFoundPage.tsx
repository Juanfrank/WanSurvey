import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadCatalogue } from '../i18n.js';
import { AuthShell } from './ui.js';

/** An address that leads to no page: said in the interface's language, with a way home. */
export function NotFoundPage() {
  const { t, i18n } = useTranslation();
  // A mistyped respondent address skips the staff words: they are loaded here then.
  const [ready, setReady] = useState(() => i18n.exists('app.notFound.title'));
  useEffect(() => {
    if (!ready) void loadCatalogue().then(() => setReady(true));
  }, [ready]);
  if (!ready) return null;
  return (
    <AuthShell title={t('app.notFound.title')}>
      <p className="mb-4 text-sm text-slate-600">{t('app.notFound.body')}</p>
      <Link
        to="/"
        className="inline-flex rounded-md border border-indigo-600 bg-indigo-600 px-4 py-2 text-sm font-semibold text-on-fill hover:border-indigo-500 hover:bg-indigo-500"
      >
        {t('app.notFound.home')}
      </Link>
    </AuthShell>
  );
}
