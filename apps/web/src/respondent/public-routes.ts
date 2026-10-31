/**
 * The addresses of the public pages (survey `/s/…`, open link `/o/…`, quick feedback `/f/…`,
 * unsubscribe `/u/…`), read without the router: a respondent's browser downloads neither the
 * router nor the query library (H6).
 */
export type PublicRoute = { page: 's' | 'o' | 'f' | 'u'; param: string } | null;

export function matchPublic(pathname: string): PublicRoute {
  const m = /^\/(s|o|f|u)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let param = m[2]!;
  try {
    param = decodeURIComponent(param);
  } catch {
    // Left as it came.
  }
  return { page: m[1] as 's' | 'o' | 'f' | 'u', param };
}

/** What quick feedback reads from the query string. */
export interface FeedbackSearch {
  r?: number;
  ref?: string;
  embed?: boolean;
}

export function parseFeedbackSearch(s: Record<string, unknown>): FeedbackSearch {
  return {
    ...(Number.isInteger(Number(s.r)) ? { r: Number(s.r) } : {}),
    ...(typeof s.ref === 'string' || typeof s.ref === 'number' ? { ref: String(s.ref) } : {}),
    ...(s.embed === 1 || s.embed === '1' || s.embed === true ? { embed: true } : {}),
  };
}

export const searchOf = (search: string): Record<string, unknown> =>
  Object.fromEntries(new URLSearchParams(search));
