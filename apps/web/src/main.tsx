import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n, isRespondentPath, previewLanguage } from './i18n.js';
import { router } from './router.js';
import { applyTheme, themePref } from './theme.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
