import { z } from 'zod';

/**
 * The look of an organisation (ADR 0001, decision 7): a default for people who have not chosen
 * their own, and an accent colour from a short palette, never free CSS. Each accent is made
 * from a hue by fixed rules that search for the lightness meeting the contrast the interface
 * promises (WCAG 2.2 AA: 4.5:1 for text), in both themes; `checkAccent` verifies the result and
 * runs when the choice is saved and in the tests.
 */

export const THEME_DEFAULTS = ['system', 'light', 'dark'] as const;
export type ThemeDefault = (typeof THEME_DEFAULTS)[number];

/** `brand` is the interface as it ships; the others replace its blue. */
export const ACCENTS = ['brand', 'teal', 'violet', 'magenta', 'graphite'] as const;
export type Accent = (typeof ACCENTS)[number];

export const OrgTheme = z.strictObject({
  default: z.enum(THEME_DEFAULTS).default('system'),
  accent: z.enum(ACCENTS).default('brand'),
});
export type OrgTheme = z.infer<typeof OrgTheme>;

/** The theme of a stored `branding`, with defaults, whatever else it holds. */
export function orgTheme(branding: unknown): OrgTheme {
  const t = (branding as { theme?: unknown } | null | undefined)?.theme;
  const parsed = OrgTheme.safeParse(t ?? {});
  return parsed.success ? parsed.data : OrgTheme.parse({});
}

// Colour arithmetic

type RGB = [number, number, number];

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as RGB;
}

const hex = ([r, g, b]: RGB) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

const fromHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(fromHex(a)), luminance(fromHex(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const color = (hue: number, sat: number, light: number) => hex(hslToRgb(hue, sat, light / 100));

/** The surfaces the accent sits on, as the stylesheet defines them. */
export const SURFACES = {
  light: { card: '#ffffff', ground: '#f4f6fc' },
  dark: { card: '#121a2b', ground: '#0b1220' },
} as const;

const AIM = 4.7; // a little above 4.5, so rounding never takes it under

interface Hue {
  hue: number;
  sat: number;
}
const HUES: Record<Exclude<Accent, 'brand'>, Hue> = {
  teal: { hue: 178, sat: 0.9 },
  violet: { hue: 262, sat: 0.75 },
  magenta: { hue: 322, sat: 0.7 },
  graphite: { hue: 220, sat: 0.14 },
};

/** The lightest lightness (percent) at which the colour has the contrast `aim` on every `on`. */
function lightestOn(h: Hue, on: string[], aim: number, sat = h.sat): number {
  for (let l = 70; l >= 5; l--)
    if (on.every((bg) => contrast(color(h.hue, sat, l), bg) >= aim)) return l;
  return 5;
}
/** The darkest lightness at which the colour has the contrast `aim` on every `on` (dark theme). */
function darkestOn(h: Hue, on: string[], aim: number, sat = h.sat): number {
  for (let l = 40; l <= 97; l++)
    if (on.every((bg) => contrast(color(h.hue, sat, l), bg) >= aim)) return l;
  return 97;
}

export type Tokens = Record<string, string>;

/**
 * CSS custom properties (without the `--color-` prefix) that replace the interface's blue in
 * one theme. Empty for `brand`: its values are the stylesheet's own.
 */
export function accentTokens(accent: Accent, mode: 'light' | 'dark'): Tokens {
  if (accent === 'brand') return {};
  const h = HUES[accent];
  const lightTints = [
    color(h.hue, Math.min(h.sat, 0.8), 96),
    color(h.hue, Math.min(h.sat, 0.8), 93),
  ];
  const tints =
    mode === 'light'
      ? lightTints
      : [color(h.hue, Math.min(h.sat, 0.5), 15), color(h.hue, Math.min(h.sat, 0.5), 20)];
  // The button takes white text; the same colour is text on white, on the ground and on the
  // tints. Fills are the same in both themes, so a button looks alike in both.
  const fill600 = lightestOn(h, ['#ffffff', SURFACES.light.ground, ...lightTints], AIM);
  const fills: Tokens = {
    'indigo-400': color(h.hue, h.sat, Math.min(fill600 + 14, 66)),
    'indigo-500': color(h.hue, h.sat, Math.min(fill600 + 7, 58)),
    'indigo-600': color(h.hue, h.sat, fill600),
    'indigo-700': color(h.hue, h.sat, Math.max(fill600 - 8, 8)),
    'indigo-800': color(h.hue, h.sat, Math.max(fill600 - 17, 7)),
    'indigo-900': color(h.hue, h.sat, Math.max(fill600 - 24, 6)),
    'indigo-950': color(h.hue, h.sat, Math.max(fill600 - 29, 4)),
  };
  if (mode === 'light') {
    const sidebar = darkestOn(h, [fills['indigo-800']!], 7, Math.min(h.sat, 0.6));
    return {
      ...fills,
      'indigo-50': color(h.hue, Math.min(h.sat, 0.8), 96),
      'indigo-100': color(h.hue, Math.min(h.sat, 0.8), 93),
      'indigo-200': color(h.hue, Math.min(h.sat, 0.75), 85),
      'indigo-300': color(h.hue, h.sat, 68),
      'indigo-ink-600': fills['indigo-600']!,
      'indigo-ink-700': fills['indigo-700']!,
      'indigo-ink-800': fills['indigo-800']!,
      'indigo-ink-900': fills['indigo-900']!,
      'indigo-ink-950': fills['indigo-950']!,
      navy: fills['indigo-800']!,
      'navy-2': fills['indigo-900']!,
      sidebar: color(h.hue, Math.min(h.sat, 0.6), sidebar),
    };
  }
  // Dark: tints become dark tints; coloured text lightens until it reads on the dark surfaces.
  const ink600 = darkestOn(
    h,
    [SURFACES.dark.card, SURFACES.dark.ground, ...tints],
    AIM,
    Math.min(h.sat + 0.1, 1),
  );
  const ink = (extra: number) =>
    color(h.hue, Math.min(h.sat + 0.1, 1), Math.min(ink600 + extra, 96));
  return {
    ...fills,
    'indigo-50': color(h.hue, Math.min(h.sat, 0.5), 15),
    'indigo-100': color(h.hue, Math.min(h.sat, 0.5), 20),
    'indigo-200': color(h.hue, Math.min(h.sat, 0.5), 29),
    'indigo-300': color(h.hue, Math.min(h.sat, 0.45), 40),
    'indigo-ink-600': ink(0),
    'indigo-ink-700': ink(6),
    'indigo-ink-800': ink(12),
    'indigo-ink-900': ink(19),
    'indigo-ink-950': ink(26),
    navy: ink(12),
    'navy-2': ink(4),
  };
}

export interface ContrastFailure {
  mode: 'light' | 'dark';
  pair: string;
  ratio: number;
}

/**
 * Every text/background pair an accent creates, in both themes, against the 4.5:1 that text
 * needs. An empty list means the accent keeps the interface's accessibility.
 */
export function checkAccent(accent: Accent): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  const need = (mode: 'light' | 'dark', pair: string, fg: string, bg: string, min = 4.5) => {
    const ratio = contrast(fg, bg);
    if (ratio < min) out.push({ mode, pair, ratio: Math.round(ratio * 100) / 100 });
  };
  for (const mode of ['light', 'dark'] as const) {
    // `brand` has no overrides: the stylesheet's own values are checked by its tests.
    const t = accentTokens(accent, mode);
    if (!Object.keys(t).length) continue;
    const { card, ground } = SURFACES[mode];
    need(mode, 'white on the button (indigo-600)', '#ffffff', t['indigo-600']!);
    need(mode, 'white on the hovered button (indigo-500)', '#ffffff', t['indigo-500']!, 3);
    for (const k of ['600', '700', '800', '900', '950'])
      for (const [name, bg] of [
        ['card', card],
        ['ground', ground],
        ['indigo-50', t['indigo-50']!],
        ['indigo-100', t['indigo-100']!],
      ] as const)
        need(mode, `indigo-ink-${k} on ${name}`, t[`indigo-ink-${k}`]!, bg);
    need(mode, 'navy on the card', t.navy!, card);
    need(mode, 'navy on the ground', t.navy!, ground);
    if (mode === 'light') {
      need(mode, 'sidebar text on the side panel', t.sidebar!, t.navy!);
      need(mode, 'white on the side panel', '#ffffff', t.navy!);
    }
  }
  return out;
}
