import { cleanup } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach } from 'vitest';
import { rendererResources, RENDERER_NS } from '../src/i18n.js';

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: [RENDERER_NS],
  defaultNS: RENDERER_NS,
  resources: rendererResources as unknown as Record<string, Record<string, object>>,
  interpolation: { escapeValue: false },
});

afterEach(async () => {
  cleanup();
  await i18next.changeLanguage('en');
});

// jsdom has no CSS.escape.
if (!globalThis.CSS?.escape) {
  (globalThis as { CSS?: { escape(s: string): string } }).CSS = {
    escape: (s: string) => s.replace(/["\\]/g, '\\$&'),
  };
}
