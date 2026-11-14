import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TechnicalFacts } from '@wansurvey/schema';
import { api, nextRouteFor } from '../api.js';
import { aboutPage, privacyPage, termsPage, type Facts, type Page } from '../about/content.js';
import { LANGUAGES, setLanguage } from '../i18n.js';
import { AppLayout, useMe } from './AppLayout.js';
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

/**
 * A person with a session who can work sees these pages inside the application's frame (menu and
 * header); anyone else, on a page of their own. Not framed: no session, no role yet, terms not yet
 * accepted, or a second factor pending (the frame would send them elsewhere).
 */
function useFramed() {
  const me = useMe({ probe: true });
  return {
    pending: me.isPending,
    hasSession: !!me.data,
    framed: !!me.data && !nextRouteFor(me.data) && (me.data.terms?.accepted ?? true),
  };
}

/** The route of the three pages: the application's frame for people who work in it. */
export function InfoLayout() {
  const { pending, framed } = useFramed();
  if (pending) return <main className="p-8 text-slate-500" aria-busy="true" />;
  return framed ? <AppLayout /> : <Outlet />;
}

/** Back: where the person came from, or the start if they came straight to the page. */
function BackLink() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <a
      href="/"
      className="text-indigo-ink-700 underline"
      onClick={(e) => {
        e.preventDefault();
        if (window.history.length > 1) window.history.back();
        else void navigate({ to: '/' });
      }}
    >
      {t('info.back')}
    </a>
  );
}

export function InfoShell({
  page,
  extra,
  framed = false,
}: {
  page: Page;
  extra?: ReactNode;
  framed?: boolean;
}) {
  const { t, i18n } = useTranslation();
  // The application's frame has its own main landmark.
  const Body = framed ? 'div' : 'main';
  return (
    <div
      className={
        framed
          ? 'mx-auto flex max-w-3xl flex-col gap-6'
          : 'mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10'
      }
    >
      <Body className="flex flex-col gap-6">
        {framed ? null : (
          <div className="flex items-center justify-between gap-4">
            <p className="flex items-center gap-3 text-2xl">
              <LogoMark className="h-9 w-9" />
              <LogoName />
            </p>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              {t('app.language')}
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1"
                value={i18n.resolvedLanguage}
                onChange={(e) => void setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} lang={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
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
              {s.links ? (
                <ul className="ml-5 flex max-w-prose list-disc flex-col gap-1">
                  {s.links.map((l) => (
                    <li key={l.to}>
                      <Link to={l.to} className="text-indigo-ink-700 underline">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </article>
      </Body>
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
        <BackLink />
      </footer>
    </div>
  );
}

function InfoPage({ build }: { build: (f: Facts, es: boolean) => Page }) {
  const { i18n, t } = useTranslation();
  const facts = useFacts();
  const { hasSession, framed } = useFramed();
  // The build and mode are for people with a session only (a protected answer).
  const technical = useQuery({
    queryKey: ['system-technical'],
    queryFn: () => api<TechnicalFacts>('/system/technical'),
    enabled: hasSession,
    retry: false,
    staleTime: Infinity,
  });
  if (facts.isPending) return <main className="p-8 text-slate-500" aria-busy="true" />;
  if (!facts.data) return <main className="p-8">{t('info.failed')}</main>;
  const data = technical.data ? { ...facts.data, technical: technical.data } : facts.data;
  return <InfoShell page={build(data, i18n.resolvedLanguage !== 'en')} framed={framed} />;
}

export const AboutPage = () => <InfoPage build={aboutPage} />;
export const PrivacyPage = () => <InfoPage build={privacyPage} />;
export const TermsPage = () => <InfoPage build={termsPage} />;
