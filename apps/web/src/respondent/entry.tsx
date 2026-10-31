import { lazy, StrictMode, Suspense, useCallback, useState } from 'react';
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
 * The public pages on their own, with no router and no query library: an open link moves on to
 * its survey by replacing the address, as the router did.
 */
function PublicApp() {
  const [route, setRoute] = useState<PublicRoute>(() => matchPublic(window.location.pathname));
  const go = useCallback((href: string) => {
    window.history.replaceState(null, '', href);
    setRoute(matchPublic(new URL(href, window.location.origin).pathname));
  }, []);
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
  return <Suspense fallback={null}>{page}</Suspense>;
}

export function startPublic() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PublicApp />
    </StrictMode>,
  );
}
