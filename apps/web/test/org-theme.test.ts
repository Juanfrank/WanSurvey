import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accentTokens } from '@wansurvey/schema';
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
});
