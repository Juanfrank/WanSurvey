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

/**
 * The language the page speaks: the browser's until a page sets the survey's own (on <html lang>),
 * so the footer reads like the survey above it and not like the device.
 */
function usePageLanguage() {
  const [lang, setLang] = useState(() => respondentLang(navigator.language));
  useEffect(() => {
    const html = document.documentElement;
    const follow = () => {
      if (html.lang) setLang(respondentLang(html.lang));
    };
    // A page may have set it already, in an effect that ran before this one ('es' is only the
    // default of index.html until a page says otherwise).
    if (html.lang !== 'es') follow();
    const watch = new MutationObserver(follow);
    watch.observe(html, { attributes: true, attributeFilter: ['lang'] });
    return () => watch.disconnect();
  }, []);
  return lang;
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
  const lang = usePageLanguage();
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
      {/* Anyone answering can read how their data is handled; a plain link, no extra code. */}
      {route?.page === 'f' ? null : (
        <footer style={{ padding: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>
          <a href="/privacy">{respondentText(lang).privacy}</a>
        </footer>
      )}
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
