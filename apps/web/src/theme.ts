import type { Tokens } from '@wansurvey/schema';
import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export const THEMES: ThemePref[] = ['system', 'light', 'dark'];
const KEY = 'ws.theme';
const query = () => window.matchMedia?.('(prefers-color-scheme: dark)');

/** The organisation's look as last seen, kept so the first paint already has it. */
export const ORG_KEY = 'ws.org';
export interface OrgCache {
  default: ThemePref;
  accent: string;
  light: Tokens;
  dark: Tokens;
}
function orgCache(): OrgCache | null {
  if (/^\/(s|o|f|u)\//.test(window.location.pathname)) return null;
  try {
    const raw = localStorage.getItem(ORG_KEY);
    return raw ? (JSON.parse(raw) as OrgCache) : null;
  } catch {
    return null;
  }
}

/**
 * The person's own choice if they made one (it always wins); otherwise the organisation's
 * default; otherwise the device's. Respondent pages never take the organisation's.
 */
export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // No storage: the organisation's default, or the device's.
  }
  const org = orgCache()?.default;
  return org === 'light' || org === 'dark' ? org : 'system';
}

/** CSS variables set on <html> for the accent, so a change of accent can take them off again. */
let applied: string[] = [];
function applyAccent(dark: boolean) {
  const root = document.documentElement.style;
  for (const k of applied) root.removeProperty(`--color-${k}`);
  const tokens = orgCache()?.[dark ? 'dark' : 'light'] ?? {};
  applied = Object.keys(tokens);
  for (const [k, v] of Object.entries(tokens)) root.setProperty(`--color-${k}`, v);
}

/** Puts the resolved theme on <html> (`public/theme.js` does the same before the first paint). */
export function applyTheme(pref: ThemePref = themePref()) {
  const dark = pref === 'dark' || (pref === 'system' && query()?.matches === true);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  applyAccent(dark);
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
