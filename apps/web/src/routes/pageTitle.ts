import { useEffect } from 'react';
import { isRespondentPath } from '../i18n.js';

const APP = 'WanSurvey';

/** "Tab · Heading · WanSurvey" from what the page shows: its h1 and the open tab, if any. */
export function titleFromPage(root: ParentNode): string {
  const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const heading = text(root.querySelector('main h1, h1'));
  const tab = text(root.querySelector('main [role="tab"][aria-selected="true"]'));
  return [tab, heading, APP].filter((x, i, all) => x && all.indexOf(x) === i).join(' · ');
}

/**
 * Keeps the document title on the screen shown, so every route gets one (screen readers announce
 * it and browser tabs tell pages apart) without each page setting it. Respondent pages name
 * themselves after the questionnaire.
 */
export function usePageTitle() {
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (isRespondentPath(window.location.pathname)) return;
        const title = titleFromPage(document);
        if (document.title !== title) document.title = title;
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-current'],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
}
