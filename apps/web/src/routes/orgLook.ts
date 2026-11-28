import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type AuthMethods, type OrgLook } from '../api.js';
import { setOrgTheme } from '../org-theme.js';

/**
 * The look of the organisation on the pages before signing in. Only an installation for one
 * organisation (SINGLE_TENANT) knows which it is there; with several, nothing is asked and the
 * pages keep WanSurvey's own look. Its colours are put on the page as once signed in (a person's
 * own theme still wins).
 */
export function useOrgLook(): OrgLook | null {
  // The same query as the sign-in page's (`useAuthMethods`): read once.
  const methods = useQuery({
    queryKey: ['auth-methods'],
    queryFn: () => api<AuthMethods>('/auth/methods'),
    staleTime: Infinity,
    retry: 1,
  });
  const look = useQuery({
    queryKey: ['org-look'],
    queryFn: () => api<OrgLook>('/public/org-look'),
    enabled: !!methods.data?.singleTenant,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const theme = look.data?.theme;
  useEffect(() => {
    if (theme) setOrgTheme(theme);
  }, [theme]);
  return look.data ?? null;
}
