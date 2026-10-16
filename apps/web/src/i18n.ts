import { rendererResources } from '@wansurvey/renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const;

/** The interface is in Spanish unless the person picks another language (remembered). */
export async function initI18n(lng = 'es', { catalogue = true } = {}) {
  const saved = (() => {
    try {
      return localStorage.getItem('ws.lang');
    } catch {
      return null;
    }
  })();
  if (typeof document !== 'undefined') document.documentElement.lang = saved ?? lng;
  await i18next.use(initReactI18next).init({
    lng: saved ?? lng,
    fallbackLng: 'es',
    supportedLngs: LANGUAGES.map((l) => l.code),
    defaultNS: 'app',
    ns: ['app', 'renderer'],
    resources: {
      en: { app: {}, ...rendererResources.en },
      es: { app: {}, ...rendererResources.es },
    } as unknown as Record<string, Record<string, object>>,
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  if (catalogue) await loadCatalogue();
}

let loading: Promise<void> | null = null;

/** Adds the staff interface's words (once); respondents' pages never ask for them. */
export function loadCatalogue() {
  loading ??= import('./i18n-catalogue.js').then(({ catalogue }) => {
    for (const [lng, words] of Object.entries(catalogue))
      i18next.addResourceBundle(lng, 'app', words, true, false);
  });
  return loading;
}

/** Pages for respondents (survey, open link, feedback, unsubscribe): no staff words. */
export const isRespondentPath = (path: string) => /^\/(s|o|f|u)\//.test(path);

// <html lang> always names the language the interface is shown in (a stale or unsupported
// choice falls back to Spanish, and so does the attribute).
i18next.on('initialized', () => {
  document.documentElement.lang = i18next.resolvedLanguage ?? 'es';
});

export function setLanguage(lng: string) {
  try {
    localStorage.setItem('ws.lang', lng);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  document.documentElement.lang = lng;
  return i18next.changeLanguage(lng);
}

/**
 * Shows the interface in another language for a moment without remembering it: screenshots
 * are taken in Spanish while tests drive the English interface.
 */
export function previewLanguage(lng: string) {
  document.documentElement.lang = lng;
  return i18next.changeLanguage(lng);
}
