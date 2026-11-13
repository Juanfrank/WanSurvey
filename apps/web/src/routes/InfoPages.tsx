import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { aboutPage, privacyPage, termsPage, type Facts, type Page } from '../about/content.js';
import { LogoMark, LogoName } from './Logo.js';

/** What the server says about this installation (public: nobody needs to sign in to read it). */
export function useFacts() {
  return useQuery({
    queryKey: ['about'],
    queryFn: () => api<Facts>('/public/about'),
    staleTime: Infinity,
    retry: 1,
  });
}

export function InfoShell({ page, extra }: { page: Page; extra?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <main className="flex flex-col gap-6">
        <p className="flex items-center gap-3 text-2xl">
          <LogoMark className="h-9 w-9" />
          <LogoName />
        </p>
        <article className="flex flex-col gap-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <header className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold">{page.title}</h1>
            <p className="text-slate-700">{page.intro}</p>
          </header>
          <nav aria-label={page.title}>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {page.sections.map((s) => (
                <li key={s.id}>
                  <a className="text-indigo-ink-700 underline" href={`#${s.id}`}>
                    {s.title.replace(/^\d+\.\s*/, '')}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {extra}
          {page.sections.map((s) => (
            <section
              key={s.id}
              id={s.id}
              aria-labelledby={`${s.id}-h`}
              className="flex flex-col gap-2"
            >
              <h2 id={`${s.id}-h`} className="text-lg font-semibold">
                {s.title}
              </h2>
              {s.paragraphs?.map((p) => (
                <p key={p} className="max-w-prose text-slate-800">
                  {p}
                </p>
              ))}
              {s.items ? (
                <ul className="ml-5 flex max-w-prose list-disc flex-col gap-1 text-slate-800">
                  {s.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </article>
      </main>
      <footer className="flex flex-wrap items-center gap-4 text-sm">
        <Link to="/about" className="text-indigo-ink-700 underline">
          {t('info.about')}
        </Link>
        <Link to="/privacy" className="text-indigo-ink-700 underline">
          {t('info.privacy')}
        </Link>
        <Link to="/terms" className="text-indigo-ink-700 underline">
          {t('info.terms')}
        </Link>
        <Link to="/" className="text-indigo-ink-700 underline">
          {t('info.back')}
        </Link>
      </footer>
    </div>
  );
}

function InfoPage({ build }: { build: (f: Facts, es: boolean) => Page }) {
  const { i18n, t } = useTranslation();
  const facts = useFacts();
  if (facts.isPending) return <main className="p-8 text-slate-500" aria-busy="true" />;
  if (!facts.data) return <main className="p-8">{t('info.failed')}</main>;
  return <InfoShell page={build(facts.data, i18n.resolvedLanguage !== 'en')} />;
}

export const AboutPage = () => <InfoPage build={aboutPage} />;
export const PrivacyPage = () => <InfoPage build={privacyPage} />;
export const TermsPage = () => <InfoPage build={termsPage} />;
