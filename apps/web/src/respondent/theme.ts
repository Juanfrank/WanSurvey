import type { CSSProperties } from 'react';

/** The project's look for respondents (project settings → web survey style). */
export interface CawiThemeView {
  primary: string;
  background: string;
  font: 'sans' | 'system' | 'serif';
  corners: 'rounded' | 'square' | 'pill';
  logo: 'left' | 'center' | 'hidden';
}

export interface Branding {
  theme: CawiThemeView;
  /** Address of the project logo, or null. */
  logo: string | null;
}

/** Relative luminance of a #rrggbb colour (WCAG). */
function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** Contrast ratio of two #rrggbb colours (1–21). */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const FONTS: Record<CawiThemeView['font'], string | undefined> = {
  sans: undefined,
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
};
const RADII: Record<CawiThemeView['corners'], [string, string, string] | null> = {
  rounded: null,
  square: ['2px', '2px', '3px'],
  pill: ['999px', '18px', '22px'],
};

const mix = (hex: string, other: 'white' | 'black', pct: number) =>
  `color-mix(in oklab, ${hex} ${pct}%, ${other})`;

/**
 * CSS variables that re-colour the page: the brand shades (fills, tints and coloured text) come
 * from the primary colour, so the renderer's classes follow without changes. In the dark theme
 * only the fills change and the page keeps its dark ground.
 */
export function themeStyle(theme: CawiThemeView | undefined, dark: boolean): CSSProperties {
  if (!theme) return {};
  const p = theme.primary;
  const vars: Record<string, string> = {
    '--color-indigo-600': p,
    '--color-indigo-700': mix(p, 'black', 85),
    '--color-indigo-500': mix(p, 'white', 88),
    // Text on fills: white unless the colour is too light for it.
    '--color-on-fill': contrast(p, '#ffffff') >= 4.5 ? '#ffffff' : '#0b1530',
  };
  if (!dark) {
    Object.assign(vars, {
      '--color-indigo-50': mix(p, 'white', 8),
      '--color-indigo-100': mix(p, 'white', 14),
      '--color-indigo-200': mix(p, 'white', 28),
      '--color-indigo-300': mix(p, 'white', 50),
      '--color-indigo-400': mix(p, 'white', 75),
      '--color-indigo-800': mix(p, 'black', 62),
      '--color-indigo-900': mix(p, 'black', 48),
      '--color-indigo-950': mix(p, 'black', 35),
      '--color-indigo-ink-600': mix(p, 'black', 92),
      '--color-indigo-ink-700': mix(p, 'black', 80),
      '--color-indigo-ink-800': mix(p, 'black', 62),
      '--color-indigo-ink-900': mix(p, 'black', 48),
      '--color-indigo-ink-950': mix(p, 'black', 35),
      backgroundColor: theme.background,
      // The focus outline follows the brand unless it fades into the page (under 3:1).
      '--color-focus':
        contrast(p, theme.background) >= 3 && contrast(p, '#ffffff') >= 3 ? p : '#0b1530',
    });
  }
  const r = RADII[theme.corners];
  if (r) Object.assign(vars, { '--radius-md': r[0], '--radius-lg': r[1], '--radius-xl': r[2] });
  const font = FONTS[theme.font];
  if (font) Object.assign(vars, { fontFamily: font, '--font-sans': font });
  return vars as CSSProperties;
}
