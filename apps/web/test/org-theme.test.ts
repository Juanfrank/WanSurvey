import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accentTokens,
  appLogoPlace,
  checkTheme,
  contrast,
  primaryFill,
  textOn,
  themeTokens,
} from '@wansurvey/schema';
import { previewVars } from '../src/admin/OrgAppearance.js';
import { setOrgTheme } from '../src/org-theme.js';
import { applyTheme, themePref } from '../src/theme.js';

const root = document.documentElement;
const get = (k: string) => root.style.getPropertyValue(`--color-${k}`);

describe('organisation theme', () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('style');
    root.removeAttribute('data-theme');
  });
  afterEach(() => {
    localStorage.clear();
    root.removeAttribute('style');
  });

  it('applies the organisation’s default when the person has not chosen, and theirs wins when they have', () => {
    setOrgTheme({ default: 'dark', accent: 'brand' });
    expect(themePref()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    localStorage.setItem('ws.theme', 'light');
    expect(themePref()).toBe('light');
    applyTheme();
    expect(root.getAttribute('data-theme')).toBe('light');
    // Choosing "system" is a choice too: it is not replaced by the organisation’s default.
    localStorage.setItem('ws.theme', 'system');
    expect(themePref()).toBe('system');
  });

  it('puts the accent on the page for the theme in use, and takes it off again', () => {
    setOrgTheme({ default: 'light', accent: 'teal' });
    expect(get('indigo-600')).toBe(accentTokens('teal', 'light')['indigo-600']);
    expect(get('navy')).toBe(accentTokens('teal', 'light').navy);
    localStorage.setItem('ws.theme', 'dark');
    applyTheme();
    expect(get('indigo-ink-600')).toBe(accentTokens('teal', 'dark')['indigo-ink-600']);
    expect(get('indigo-50')).toBe(accentTokens('teal', 'dark')['indigo-50']);
    // The standard blue is the stylesheet’s own: nothing is set.
    setOrgTheme({ default: 'light', accent: 'brand' });
    expect(root.getAttribute('style') ?? '').not.toContain('--color-indigo');
  });

  it('changes from one accent to another without leaving the first one’s colours behind', () => {
    setOrgTheme({ default: 'light', accent: 'violet' });
    const violet = get('indigo-600');
    setOrgTheme({ default: 'light', accent: 'graphite' });
    expect(get('indigo-600')).toBe(accentTokens('graphite', 'light')['indigo-600']);
    expect(get('indigo-600')).not.toBe(violet);
  });

  it('does not give a respondent’s page the organisation’s look', () => {
    setOrgTheme({ default: 'dark', accent: 'teal' });
    window.history.pushState({}, '', '/s/abc123');
    try {
      expect(themePref()).toBe('system');
      applyTheme();
      expect(get('indigo-600')).toBe('');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('puts the colours, the accent and the corners on the page, and takes them off again', () => {
    setOrgTheme({
      default: 'light',
      accent: 'brand',
      primary: '#7a1f5c',
      accentColor: '#ffd400',
      radius: 'round',
    });
    expect(get('indigo-600')).toBe('#7a1f5c');
    expect(get('accent')).toBe('#ffd400');
    expect(get('on-accent')).toBe('#000000');
    expect(root.style.getPropertyValue('--radius-md')).toBe('12px');
    setOrgTheme({ default: 'light', accent: 'brand' });
    expect(root.getAttribute('style') ?? '').toBe('');
  });
});

describe('the organisation’s own colours', () => {
  const lum = (h: string) => contrast(h, '#000000');

  it('makes the whole scale from the main colour, keeping the chosen one when white text reads on it', () => {
    const light = themeTokens({ primary: '#7A1F5C' }, 'light');
    expect(light['indigo-600']).toBe('#7a1f5c');
    // From light to dark, step by step.
    const steps = ['400', '500', '600', '700', '800', '900', '950'].map(
      (k) => light[`indigo-${k}`]!,
    );
    for (let i = 1; i < steps.length; i++) expect(lum(steps[i]!)).toBeLessThan(lum(steps[i - 1]!));
    expect(lum(light['indigo-50']!)).toBeGreaterThan(lum(light['indigo-100']!));
    // The dark theme keeps the fills and lightens the coloured text.
    const dark = themeTokens({ primary: '#7a1f5c' }, 'dark');
    expect(dark['indigo-600']).toBe('#7a1f5c');
    expect(contrast(dark['indigo-ink-600']!, '#121a2b')).toBeGreaterThanOrEqual(4.5);
    expect(checkTheme({ primary: '#7a1f5c' })).toEqual([]);
  });

  it('darkens a main colour white text cannot be read on, and says so', () => {
    for (const chosen of ['#ffd400', '#00ff00', '#ffffff', '#7fb3ff']) {
      const p = primaryFill(chosen);
      expect(p.adjusted, chosen).toBe(true);
      expect(contrast('#ffffff', p.fill)).toBeGreaterThanOrEqual(4.5);
      expect(themeTokens({ primary: chosen }, 'light')['indigo-600']).toBe(p.fill);
      expect(checkTheme({ primary: chosen }), chosen).toEqual([]);
    }
    expect(primaryFill('#0050dd')).toMatchObject({ fill: '#0050dd', adjusted: false });
  });

  it('keeps text readable for any main colour and accent', () => {
    for (let i = 0; i < 300; i++) {
      const c = `#${((i * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(-6)}`;
      expect(checkTheme({ primary: c, accentColor: c }), c).toEqual([]);
      expect(contrast(textOn(c), c)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('refuses a side panel whose text cannot be read, and darkens a light panel in the dark theme', () => {
    const bad = checkTheme({ sidebar: { background: '#ffffff', text: '#eeeeee' } });
    expect(bad.map((f) => f.pair)).toContain('text on the side panel');
    const ok = { sidebar: { background: '#f4f6fc', text: '#20263a' } };
    expect(checkTheme(ok)).toEqual([]);
    expect(themeTokens(ok, 'light')['navy-fill']).toBe('#f4f6fc');
    const dark = themeTokens(ok, 'dark');
    expect(lum(dark['navy-fill']!)).toBeLessThan(lum('#2a3650'));
    expect(contrast(dark['sidebar-fg']!, dark['navy-fill']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark.sidebar!, dark['navy-fill']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('draws the preview from the stylesheet’s values plus the theme, the accent following the main colour', () => {
    const v = previewVars({ primary: '#7a1f5c' }, 'light') as Record<string, string>;
    expect(v['--color-indigo-600']).toBe('#7a1f5c');
    expect(v['--color-accent']).toBe('#7a1f5c');
    expect(v['--radius-md']).toBe('8px');
    const plain = previewVars({}, 'dark') as Record<string, string>;
    expect(plain['--color-navy-fill']).toBe('#0e1730');
  });

  it('puts WanSurvey under the organisation’s logo by default only in a single-tenant installation', () => {
    expect(appLogoPlace(undefined, true)).toBe('sub');
    expect(appLogoPlace({}, false)).toBe('main');
    expect(appLogoPlace({ appLogo: 'main' }, true)).toBe('main');
    expect(appLogoPlace({ appLogo: 'sub' }, false)).toBe('sub');
  });
});
