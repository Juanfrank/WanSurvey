import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { closedReason, Shell, type ClosedReason } from './RespondentPage.js';
import { respondentLang, respondentText } from './text.js';

const key = (slug: string) => `wansurvey.open.${slug}`;

/**
 * An open link (`/o/$slug`): the first visit starts an anonymous interview and the browser
 * keeps its token, so coming back continues the same one instead of starting another (W6).
 */
export function OpenLinkPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const [failed, setFailed] = useState<ClosedReason | null>(null);
  // The browser's language when the catalogue has it; the page says which one it uses.
  const lang = respondentLang(navigator.language);
  const t = respondentText(lang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    void (async () => {
      let token: string | null = null;
      try {
        token = localStorage.getItem(key(slug));
      } catch {
        // Without storage, each visit starts a new interview.
      }
      try {
        if (!token) {
          token = (await api<{ token: string }>(`/public/o/${slug}/start`, { method: 'POST' }))
            .token;
          try {
            localStorage.setItem(key(slug), token);
          } catch {
            // As above.
          }
        }
        // The open link's parameters (?sede=2) go on to the survey, which keeps them.
        await navigate({ href: `/s/${token}${window.location.search}`, replace: true });
      } catch (e) {
        setFailed(closedReason(e));
      }
    })();
  }, [slug, navigate]);

  return (
    <Shell title="">
      {failed ? <p role="alert">{t[failed]}</p> : <p aria-busy="true">{t.loading}</p>}
    </Shell>
  );
}
