import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export const THEMES: ThemePref[] = ['system', 'light', 'dark'];
const KEY = 'ws.theme';
const query = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Puts the resolved theme on <html> (`public/theme.js` does the same before the first paint). */
export function applyTheme(pref: ThemePref = themePref()) {
  const dark = pref === 'dark' || (pref === 'system' && query()?.matches === true);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0b1220' : '#0a2e7a');
}

/** The person's theme choice, remembered on this device; "system" follows the device. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(themePref);
  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system') return;
    const m = query();
    const on = () => applyTheme('system');
    m?.addEventListener('change', on);
    return () => m?.removeEventListener('change', on);
  }, [pref]);
  return [
    pref,
    (v: ThemePref) => {
      try {
        localStorage.setItem(KEY, v);
      } catch {
        // Not remembered without storage.
      }
      setPref(v);
    },
  ] as const;
}
