import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n, previewLanguage } from './i18n.js';
import { router } from './router.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

await initI18n();
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
