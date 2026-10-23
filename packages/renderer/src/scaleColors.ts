import type { Question } from '@wansurvey/schema';

type Palette = NonNullable<NonNullable<Question['scale']>['palette']>;

/** Hue for a point of the scale: 0 = red, 45 = amber, 140 = green, 225 = blue. */
function hue(palette: Palette, n: number, min: number, max: number): number | null {
  const t = max === min ? 1 : (n - min) / (max - min);
  if (palette === 'nps') return n <= 6 ? 0 : n <= 8 ? 45 : 140;
  if (palette === 'diverging') return t <= 0.5 ? 90 * t : 45 + 190 * (t - 0.5);
  return null;
}

/** Relative luminance (WCAG) of an opaque HSL colour. */
function luminance(h: number, s: number, l: number): number {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
}

const DARK_INK = '#0b1530';
const DARK_LUM = 0.0094;

/**
 * The chosen fill and its text: white or dark, whichever contrasts more; a mid-tone fill that
 * reaches 4.5:1 with neither is darkened until white text does.
 */
function readable(h: number, s: number, l: number): { fill: string; ink: string } {
  for (let x = l; x > 0; x -= 2) {
    const y = luminance(h, s, x);
    const white = 1.05 / (y + 0.05);
    const dark = (y + 0.05) / (DARK_LUM + 0.05);
    if (dark >= 4.5 && dark >= white) return { fill: `hsl(${h} ${s}% ${x}%)`, ink: DARK_INK };
    if (white >= 4.5) return { fill: `hsl(${h} ${s}% ${x}%)`, ink: '#ffffff' };
  }
  return { fill: `hsl(${h} ${s}% ${l}%)`, ink: '#ffffff' };
}

/**
 * Colours of one point, or undefined without a palette. `fill` is the chosen state, `tint`
 * the resting one (with a coloured border), `ink` the text on the fill, so every point stays legible in both themes;
 * the number is always written, so colour is never the only cue.
 */
export function scaleColor(
  palette: Palette | undefined,
  n: number,
  min: number,
  max: number,
): { fill: string; tint: string; border: string; ink: string } | undefined {
  if (!palette) return undefined;
  const h = hue(palette, n, min, max);
  if (h === null) {
    const t = max === min ? 1 : (n - min) / (max - min);
    const l = 78 - 46 * t;
    return {
      ...readable(225, 75, l),
      tint: `hsl(225 75% ${l}% / 0.18)`,
      border: `hsl(225 75% ${l}%)`,
    };
  }
  return {
    ...readable(h, 70, 42),
    tint: `hsl(${h} 70% 50% / 0.16)`,
    border: `hsl(${h} 70% 45%)`,
  };
}
