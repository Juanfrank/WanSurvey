import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { matchPublic, parseFeedbackSearch, searchOf, type PublicRoute } from './public-routes.js';
import { respondentLang, respondentText } from './text.js';

const RespondentPage = lazy(() =>
  import('./RespondentPage.js').then((m) => ({ default: m.RespondentPage })),
);
const OpenLinkPage = lazy(() =>
  import('./OpenLinkPage.js').then((m) => ({ default: m.OpenLinkPage })),
);
const UnsubscribePage = lazy(() =>
  import('./UnsubscribePage.js').then((m) => ({ default: m.UnsubscribePage })),
);
const FeedbackPage = lazy(() =>
  import('../feedback/FeedbackPage.js').then((m) => ({ default: m.FeedbackPage })),
);

/** The page's language (`<html lang>`), which each public page sets: the survey's own one. */
function usePageLang(): string {
  const [lang, setLang] = useState(() => document.documentElement.lang);
  useEffect(() => {
    const html = document.documentElement;
    const watch = new MutationObserver(() => setLang(html.lang));
    watch.observe(html, { attributes: true, attributeFilter: ['lang'] });
    return () => watch.disconnect();
  }, []);
  return lang;
}

/**
 * Anyone answering can read how their data is handled: a plain link, no extra code, in the
 * language of the page above it (the questionnaire's, once the survey has opened) rather than
 * the browser's, and marked with that language for screen readers.
 */
function PrivacyFooter() {
  const lang = respondentLang(usePageLang());
  return (
    <footer lang={lang} style={{ padding: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>
      <a href="/privacy">{respondentText(lang).privacy}</a>
    </footer>
  );
}

/**
 * The public pages on their own, with no router and no query library: an open link moves on to
 * its survey by replacing the address, as the router did.
 */
function PublicApp() {
  const [route, setRoute] = useState<PublicRoute>(() => matchPublic(window.location.pathname));
  const go = useCallback((href: string) => {
    window.history.replaceState(null, '', href);
    setRoute(matchPublic(new URL(href, window.location.origin).pathname));
  }, []);
  // A page that is not found speaks the browser's language, and says so.
  const unknown = !route;
  useEffect(() => {
    if (unknown) document.documentElement.lang = respondentLang(navigator.language);
  }, [unknown]);
  let page;
  switch (route?.page) {
    case 's':
      page = <RespondentPage token={route.param} />;
      break;
    case 'o':
      page = <OpenLinkPage slug={route.param} go={go} />;
      break;
    case 'u':
      page = <UnsubscribePage token={route.param} />;
      break;
    case 'f':
      page = (
        <FeedbackPage
          slug={route.param}
          search={parseFeedbackSearch(searchOf(window.location.search))}
        />
      );
      break;
    default:
      page = (
        <main>
          <p role="alert">{respondentText(respondentLang(navigator.language)).notFound}</p>
        </main>
      );
  }
  return (
    <>
      <Suspense fallback={null}>{page}</Suspense>
      {route?.page === 'f' ? null : <PrivacyFooter />}
    </>
  );
}

export function startPublic() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PublicApp />
    </StrictMode>,
  );
}
