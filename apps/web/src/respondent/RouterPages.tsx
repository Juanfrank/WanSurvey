import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { FeedbackPage as Feedback } from '../feedback/FeedbackPage.js';
import { OpenLinkPage as OpenLink } from './OpenLinkPage.js';
import { parseFeedbackSearch } from './public-routes.js';
import { RespondentPage as Respondent } from './RespondentPage.js';
import { UnsubscribePage as Unsubscribe } from './UnsubscribePage.js';

/**
 * The public pages as routes of the application, for a visit that reaches them from inside it.
 * A respondent who opens a link gets `entry.tsx` instead, without the router.
 */
export function RespondentRoute() {
  const { token } = useParams({ strict: false }) as { token: string };
  return <Respondent token={token} />;
}

export function OpenLinkRoute() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const go = useCallback((href: string) => navigate({ href, replace: true }), [navigate]);
  return <OpenLink slug={slug} go={go} />;
}

export function UnsubscribeRoute() {
  const { token } = useParams({ strict: false }) as { token: string };
  return <Unsubscribe token={token} />;
}

export function FeedbackRoute() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return <Feedback slug={slug} search={parseFeedbackSearch(search)} />;
}
