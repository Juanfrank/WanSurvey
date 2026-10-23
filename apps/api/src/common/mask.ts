const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request URL with its secret parts hidden for the logs: path segments that look like tokens
 * (24 or more URL-safe characters, ids aside) and `token`-like query parameters.
 */
export function maskTokens(url: string | undefined): string | undefined {
  if (!url) return url;
  const [path, query] = url.split('?', 2) as [string, string | undefined];
  const masked = path.replace(/[A-Za-z0-9_-]{24,}/g, (s) => (UUID.test(s) ? s : '…'));
  if (query === undefined) return masked;
  const q = query.replace(/((?:^|&)(?:token|t|code|state)=)[^&]*/gi, '$1…');
  return `${masked}?${q}`;
}
