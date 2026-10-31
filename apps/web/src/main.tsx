import { initI18n, isRespondentPath, previewLanguage } from './i18n.js';
import { applyTheme, themePref } from './theme.js';
import './styles.css';

// Respondents' pages start without the staff interface's words (H6).
await initI18n('es', { catalogue: !isRespondentPath(window.location.pathname) });
// The colour theme: set before the first paint by public/theme.js; here it follows the system
// while the person has not chosen one.
applyTheme();
window
  .matchMedia?.('(prefers-color-scheme: dark)')
  .addEventListener('change', () => themePref() === 'system' && applyTheme());
// Screenshots switch the language for one picture (`ws:lang`); nothing is stored.
window.addEventListener('ws:lang', (e) => void previewLanguage((e as CustomEvent<string>).detail));

// The app shell works offline once installed (D3); development stays uncached.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

// A respondent's browser downloads neither the router nor the query library (H6): the public
// pages have their own entry.
if (isRespondentPath(window.location.pathname))
  (await import('./respondent/entry.js')).startPublic();
else (await import('./app.js')).startApp();
