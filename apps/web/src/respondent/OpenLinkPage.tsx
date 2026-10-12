import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Shell } from './RespondentPage.js';
import { respondentText } from './text.js';

const key = (slug: string) => `wansurvey.open.${slug}`;

/**
 * An open link (`/o/$slug`): the first visit starts an anonymous interview and the browser
 * keeps its token, so coming back continues the same one instead of starting another (W6).
 */
export function OpenLinkPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const [failed, setFailed] = useState<'notFound' | 'failed' | null>(null);
  const t = respondentText(navigator.language);

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
        await navigate({ to: '/s/$token', params: { token }, replace: true });
      } catch (e) {
        setFailed(e instanceof ApiError && e.status === 404 ? 'notFound' : 'failed');
      }
    })();
  }, [slug, navigate]);

  return (
    <Shell title="">
      {failed ? <p role="alert">{t[failed]}</p> : <p aria-busy="true">{t.loading}</p>}
    </Shell>
  );
}
