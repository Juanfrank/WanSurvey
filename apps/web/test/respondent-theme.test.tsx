import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/respondent/RespondentPage.js';
import { contrast, mixed, themeProblems, type CawiThemeView } from '../src/respondent/theme.js';

const theme = (primary: string, logoAlt = ''): CawiThemeView => ({
  primary,
  background: '#f8fafc',
  font: 'sans',
  corners: 'rounded',
  logo: 'left',
  logoAlt,
});

describe('web survey style', () => {
  it('mixes colours in OKLab as the stylesheet does', () => {
    expect(mixed('#0050dd', 'black', 100)).toBe('#0050dd');
    expect(mixed('#0050dd', 'white', 0)).toBe('#ffffff');
    expect(mixed('#0050dd', 'black', 0)).toBe('#000000');
    // A shade between the colour and black is darker than the colour.
    expect(contrast(mixed('#0050dd', 'black', 62), '#ffffff')).toBeGreaterThan(
      contrast('#0050dd', '#ffffff'),
    );
  });

  it('accepts the default and dark brand colours', () => {
    expect(themeProblems(theme('#0050dd'))).toEqual([]);
    expect(themeProblems(theme('#7a1f5c'))).toEqual([]);
  });

  it('finds every derived shade a light main colour leaves unreadable', () => {
    // Yellow: dark text on the buttons reads, but the coloured text and the marks do not.
    expect(themeProblems(theme('#ffd400'))).toEqual(['ink', 'mark']);
    // A middle grey fails white and dark text on the buttons alike.
    expect(themeProblems(theme('#777777'))).toContain('fill');
  });

  it('names the logo for screen readers when the project describes it', () => {
    const { rerender } = render(
      <Shell title="Survey" branding={{ theme: theme('#0050dd', 'Instituto X'), logo: '/l.png' }}>
        <p>Body</p>
      </Shell>,
    );
    expect(screen.getByRole('img', { name: 'Instituto X' })).toBeTruthy();
    rerender(
      <Shell title="Survey" branding={{ theme: theme('#0050dd'), logo: '/l.png' }}>
        <p>Body</p>
      </Shell>,
    );
    expect(screen.queryByRole('img')).toBeNull(); // decorative
  });
});
