import type { CSSProperties } from 'react';

/** The project's look for respondents (project settings → web survey style). */
export interface CawiThemeView {
  primary: string;
  background: string;
  font: 'sans' | 'system' | 'serif';
  corners: 'rounded' | 'square' | 'pill';
  logo: 'left' | 'center' | 'hidden';
  /** What screen readers say for the logo; empty when the name is already beside it. */
  logoAlt?: string;
}

export interface Branding {
  theme: CawiThemeView;
  /** Address of the project logo, or null. */
  logo: string | null;
}

/** Relative luminance of a #rrggbb colour (WCAG). */
function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
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

// The same mixes worked out here (CSS Color 4: sRGB → OKLab, mixed, and back), so the derived
// shades can be checked before a style is saved.
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: [number, number, number]): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** `mix` as a #rrggbb colour. */
export function mixed(hex: string, other: 'white' | 'black', pct: number): string {
  const [a, b] = [toOklab(hex), other === 'white' ? [1, 0, 0] : [0, 0, 0]];
  const w = pct / 100;
  return fromOklab([0, 1, 2].map((i) => a[i]! * w + b[i]! * (1 - w)) as [number, number, number]);
}

/** Text on fills of the colour: white unless the colour is too light for it. */
const onFillOf = (p: string) => (contrast(p, '#ffffff') >= 4.5 ? '#ffffff' : '#0b1530');

/** What a web survey style fails, so it cannot be saved: each a reason respondents could not read it. */
export type ThemeProblem = 'fill' | 'ink' | 'mark';

/**
 * Checks every colour the page derives from the main one, in the light theme, against what it
 * sits on (the white card and the selected answer's tint): text on buttons and coloured text
 * need 4.5:1, the selected answer's border and dot and the progress bar 3:1 (WCAG 1.4.3, 1.4.11).
 * The page background carries no text or field (they sit on the white card), so it is free.
 */
export function themeProblems(theme: Pick<CawiThemeView, 'primary'>): ThemeProblem[] {
  const p = theme.primary;
  const white = '#ffffff';
  const tint = mixed(p, 'white', 8); // indigo-50, behind the selected answer
  const problems: ThemeProblem[] = [];
  // The button's text (as themeStyle picks it) on the button and on its hover shade.
  const onFill = onFillOf(p);
  if (contrast(p, onFill) < 4.5 || contrast(mixed(p, 'black', 85), onFill) < 4.5)
    problems.push('fill');
  const inks = [92, 80, 62].map((pct) => mixed(p, 'black', pct)); // ink-600, -700, -800
  if (inks.some((ink) => contrast(ink, white) < 4.5) || contrast(inks[2]!, tint) < 4.5)
    problems.push('ink');
  // The tint is darker than white, so 3:1 on it holds on white too.
  if (contrast(p, tint) < 3) problems.push('mark');
  return problems;
}

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
    '--color-on-fill': onFillOf(p),
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
