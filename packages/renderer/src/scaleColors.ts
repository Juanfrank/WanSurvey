import type { Question } from '@wansurvey/schema';

type Palette = NonNullable<NonNullable<Question['scale']>['palette']>;

/** Hue for a point of the scale: 0 = red, 45 = amber, 140 = green, 225 = blue. */
function hue(palette: Palette, n: number, min: number, max: number): number | null {
  const t = max === min ? 1 : (n - min) / (max - min);
  if (palette === 'nps') return n <= 6 ? 0 : n <= 8 ? 45 : 140;
  if (palette === 'diverging') return t <= 0.5 ? 90 * t : 45 + 190 * (t - 0.5);
  return null;
}

/**
 * Colours of one point, or undefined without a palette. `fill` is the chosen state, `tint`
 * the resting one (with a coloured border), so every point stays legible in both themes;
 * the number is always written, so colour is never the only cue.
 */
export function scaleColor(
  palette: Palette | undefined,
  n: number,
  min: number,
  max: number,
): { fill: string; tint: string; border: string } | undefined {
  if (!palette) return undefined;
  const h = hue(palette, n, min, max);
  if (h === null) {
    const t = max === min ? 1 : (n - min) / (max - min);
    const l = 78 - 46 * t;
    return {
      fill: `hsl(225 75% ${l}%)`,
      tint: `hsl(225 75% ${l}% / 0.18)`,
      border: `hsl(225 75% ${l}%)`,
    };
  }
  return {
    fill: `hsl(${h} 70% 42%)`,
    tint: `hsl(${h} 70% 50% / 0.16)`,
    border: `hsl(${h} 70% 45%)`,
  };
}
