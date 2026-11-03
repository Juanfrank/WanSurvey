import { accentTokens, type OrgTheme } from '@wansurvey/schema';
import { applyTheme, ORG_KEY, type OrgCache } from './theme.js';

/**
 * Keeps the organisation's default and accent for this device and puts them on the page. It lives
 * apart from `theme.ts` so the respondent pages, which never call it, do not carry the colour code.
 */
export function setOrgTheme(theme: OrgTheme) {
  try {
    const cache: OrgCache = {
      default: theme.default,
      accent: theme.accent,
      light: accentTokens(theme.accent, 'light'),
      dark: accentTokens(theme.accent, 'dark'),
    };
    localStorage.setItem(ORG_KEY, JSON.stringify(cache));
  } catch {
    // Not remembered without storage; it is fetched again at the next sign-in.
  }
  applyTheme();
}
