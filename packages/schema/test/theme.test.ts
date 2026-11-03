import { describe, expect, it } from 'vitest';
import { ACCENTS, OrgTheme, accentTokens, checkAccent, contrast, orgTheme } from '../src/theme.js';

describe('organisation theme', () => {
  it('knows the contrast of two colours as WCAG defines it', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThan(4.5);
  });

  it('keeps every accent of the palette within 4.5:1 for text, in both themes', () => {
    for (const a of ACCENTS) expect(checkAccent(a), a).toEqual([]);
  });

  it('leaves the interface as it ships for the brand accent, and changes it for the others', () => {
    expect(accentTokens('brand', 'light')).toEqual({});
    expect(accentTokens('brand', 'dark')).toEqual({});
    for (const a of ACCENTS.filter((x) => x !== 'brand')) {
      const light = accentTokens(a, 'light');
      const dark = accentTokens(a, 'dark');
      expect(Object.keys(light).length).toBeGreaterThan(15);
      expect(light['indigo-600']).toMatch(/^#[0-9a-f]{6}$/);
      // The fills keep their colour in the dark theme; the tints and the text change.
      expect(dark['indigo-600']).toBe(light['indigo-600']);
      expect(dark['indigo-50']).not.toBe(light['indigo-50']);
      expect(dark['indigo-ink-600']).not.toBe(light['indigo-ink-600']);
    }
  });

  it('reads a stored branding with defaults, and refuses a colour outside the palette', () => {
    expect(orgTheme({})).toEqual({ default: 'system', accent: 'brand' });
    expect(orgTheme(null)).toEqual({ default: 'system', accent: 'brand' });
    expect(orgTheme({ logo: 'x', theme: { default: 'dark', accent: 'teal' } })).toEqual({
      default: 'dark',
      accent: 'teal',
    });
    // Something unreadable falls back to the defaults instead of breaking the screen.
    expect(orgTheme({ theme: { accent: '#ff00ff' } })).toEqual({
      default: 'system',
      accent: 'brand',
    });
    expect(OrgTheme.safeParse({ accent: '#ff00ff' }).success).toBe(false);
    expect(OrgTheme.safeParse({ default: 'sepia' }).success).toBe(false);
    expect(OrgTheme.safeParse({ accent: 'teal', css: 'body{}' }).success).toBe(false);
  });
});
