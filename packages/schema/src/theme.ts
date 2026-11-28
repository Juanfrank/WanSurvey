import { z } from 'zod';
import { mixed, mixedWith } from './cawi-theme.js';

/**
 * The look of an organisation (ADR 0001, decision 7): a default for people who have not chosen
 * their own, and its colours: a main colour from a short palette or its own (`primary`), an
 * accent, the side panel's background and text, and the corners. Never free CSS: every value is
 * a #rrggbb colour or a word from a list, turned into the stylesheet's custom properties by the
 * fixed rules below.
 *
 * The rules keep the contrast the interface promises (WCAG 2.2 AA: 4.5:1 for text), in both
 * themes. Each palette colour is made from a hue by searching for the lightness that meets it. A
 * main colour of the organisation's own that white text could not be read on is made darker until
 * it can (`primaryFill` says so, and the settings show the colour used). A side panel whose text
 * cannot be read on its background is refused (`checkTheme`), when the choice is saved and in the
 * tests.
 */

export const THEME_DEFAULTS = ['system', 'light', 'dark'] as const;
export type ThemeDefault = (typeof THEME_DEFAULTS)[number];

/** `brand` is the interface as it ships; the others replace its blue. */
export const ACCENTS = ['brand', 'teal', 'violet', 'magenta', 'graphite'] as const;
export type Accent = (typeof ACCENTS)[number];

/** Corners of cards, fields and buttons; `standard` is the stylesheet's own (8/10/12 px). */
export const RADII = ['square', 'small', 'standard', 'round'] as const;
export type Radius = (typeof RADII)[number];

/**
 * Where the WanSurvey logo goes. `main`: at the top of the side panel, with the organisation's
 * logo beside it if there is one. `sub`: the organisation's logo (or its name) at the top and the
 * WanSurvey logo small, at the foot of the side panel and under the sign-in page's logo.
 */
export const APP_LOGO_PLACES = ['main', 'sub'] as const;
export type AppLogoPlace = (typeof APP_LOGO_PLACES)[number];

/** A colour as `#rrggbb`: nothing else reaches the stylesheet. */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour as #rrggbb');

export const OrgTheme = z.strictObject({
  default: z.enum(THEME_DEFAULTS).default('system'),
  accent: z.enum(ACCENTS).default('brand'),
  /** The organisation's own main colour (the interface's blue); replaces `accent` when set. */
  primary: HexColor.optional(),
  /** The accent: the open section in the side panel and the panel's button. */
  accentColor: HexColor.optional(),
  /** The side panel, in the light theme (the dark theme keeps a dark panel of the same hue). */
  sidebar: z.strictObject({ background: HexColor, text: HexColor }).optional(),
  radius: z.enum(RADII).optional(),
  /** Absent: `sub` in single-tenant mode, `main` otherwise (see `appLogoPlace`). */
  appLogo: z.enum(APP_LOGO_PLACES).optional(),
});
export type OrgTheme = z.infer<typeof OrgTheme>;

/** The theme of a stored `branding`, with defaults, whatever else it holds. */
export function orgTheme(branding: unknown): OrgTheme {
  const t = (branding as { theme?: unknown } | null | undefined)?.theme;
  const parsed = OrgTheme.safeParse(t ?? {});
  return parsed.success ? parsed.data : OrgTheme.parse({});
}

/**
 * Where the WanSurvey logo goes: the organisation's choice, or by default the sub-logo in an
 * installation for one organisation (its logo, or its name, is the main one there) and the main
 * logo otherwise.
 */
export function appLogoPlace(
  theme: Pick<OrgTheme, 'appLogo'> | undefined,
  singleTenant: boolean,
): AppLogoPlace {
  return theme?.appLogo ?? (singleTenant ? 'sub' : 'main');
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

/** Hue (degrees), saturation (0–1) and lightness (percent) of a `#rrggbb` colour. */
function hslOf(h: string): { hue: number; sat: number; light: number } {
  const [r, g, b] = fromHex(h).map((v) => v / 255) as RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0, light: l * 100 };
  const sat = d / (1 - Math.abs(2 * l - 1));
  const hue =
    max === r
      ? 60 * (((g - b) / d) % 6)
      : max === g
        ? 60 * ((b - r) / d + 2)
        : 60 * ((r - g) / d + 4);
  return { hue: (hue + 360) % 360, sat: Math.min(sat, 1), light: l * 100 };
}

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

/**
 * CSS custom properties that replace the stylesheet's values in one theme. A key without `--` is
 * a colour (`indigo-600` is `--color-indigo-600`); one with it is the property itself
 * (`--radius-md`).
 */
export type Tokens = Record<string, string>;

/** The light tints of a hue (indigo-50 and -100), behind selected rows and chips. */
const lightTintsOf = (h: Hue) => [
  color(h.hue, Math.min(h.sat, 0.8), 96),
  color(h.hue, Math.min(h.sat, 0.8), 93),
];

/** The surfaces the button's colour is also text on, in the light theme. */
const fillGrounds = (h: Hue) => ['#ffffff', SURFACES.light.ground, ...lightTintsOf(h)];

/**
 * The shades of one hue that replace the interface's blue, from the button's lightness
 * (`fill600`, percent), or the button's exact colour (`exact`: the organisation's own, when it
 * passes as it is).
 */
function scaleTokens(h: Hue, mode: 'light' | 'dark', fill600: number, exact?: string): Tokens {
  const lightTints = lightTintsOf(h);
  const tints =
    mode === 'light'
      ? lightTints
      : [color(h.hue, Math.min(h.sat, 0.5), 15), color(h.hue, Math.min(h.sat, 0.5), 20)];
  // The button takes white text; the same colour is text on white, on the ground and on the
  // tints. Fills are the same in both themes, so a button looks alike in both.
  const fills: Tokens = {
    'indigo-400': color(h.hue, h.sat, Math.min(fill600 + 14, 66)),
    'indigo-500': color(h.hue, h.sat, Math.min(fill600 + 7, 58)),
    'indigo-600': exact ?? color(h.hue, h.sat, fill600),
    'indigo-700': color(h.hue, h.sat, Math.max(fill600 - 8, 8)),
    'indigo-800': color(h.hue, h.sat, Math.max(fill600 - 17, 7)),
    'indigo-900': color(h.hue, h.sat, Math.max(fill600 - 24, 6)),
    'indigo-950': color(h.hue, h.sat, Math.max(fill600 - 29, 4)),
  };
  if (mode === 'light') {
    const sidebar = darkestOn(h, [fills['indigo-800']!], 7, Math.min(h.sat, 0.6));
    return {
      ...fills,
      'indigo-50': lightTints[0]!,
      'indigo-100': lightTints[1]!,
      'indigo-200': color(h.hue, Math.min(h.sat, 0.75), 85),
      'indigo-300': color(h.hue, h.sat, 68),
      'indigo-ink-600': fills['indigo-600']!,
      'indigo-ink-700': fills['indigo-700']!,
      'indigo-ink-800': fills['indigo-800']!,
      'indigo-ink-900': fills['indigo-900']!,
      'indigo-ink-950': fills['indigo-950']!,
      navy: fills['indigo-800']!,
      'navy-2': fills['indigo-900']!,
      // The side panel takes the darkest shade, with its text checked on it.
      'navy-fill': fills['indigo-800']!,
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
    'indigo-50': tints[0]!,
    'indigo-100': tints[1]!,
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

/**
 * CSS custom properties (without the `--color-` prefix) that replace the interface's blue in
 * one theme. Empty for `brand`: its values are the stylesheet's own.
 */
export function accentTokens(accent: Accent, mode: 'light' | 'dark'): Tokens {
  if (accent === 'brand') return {};
  const h = HUES[accent];
  return scaleTokens(h, mode, lightestOn(h, fillGrounds(h), AIM));
}

/**
 * The button's colour made from the organisation's own main colour: the colour itself when white
 * text reads on it (4.5:1), it reads as text on white, on the ground and on the light tints, and
 * its hovered shade keeps 3:1 with white; otherwise the same hue made darker until it does
 * (`adjusted`). The settings show the colour used, so nobody is surprised.
 */
export function primaryFill(primary: string): {
  fill: string;
  adjusted: boolean;
  hue: number;
  sat: number;
  light: number;
} {
  const { hue, sat, light } = hslOf(primary);
  const h = { hue, sat };
  const hoverOk = (l: number) => contrast('#ffffff', color(hue, sat, Math.min(l + 7, 58))) >= 3;
  const exact = primary.toLowerCase();
  if (fillGrounds(h).every((bg) => contrast(exact, bg) >= 4.5) && hoverOk(Math.round(light)))
    return { fill: exact, adjusted: false, hue, sat, light: Math.round(light) };
  for (let l = Math.min(Math.floor(light), 70); l >= 5; l--) {
    const c = color(hue, sat, l);
    if (fillGrounds(h).every((bg) => contrast(c, bg) >= AIM) && hoverOk(l))
      return { fill: c, adjusted: true, hue, sat, light: l };
  }
  return { fill: color(hue, sat, 5), adjusted: true, hue, sat, light: 5 };
}

/** The interface's blue replaced by the shades of the organisation's own main colour. */
export function primaryTokens(primary: string, mode: 'light' | 'dark'): Tokens {
  const p = primaryFill(primary);
  return scaleTokens({ hue: p.hue, sat: p.sat }, mode, p.light, p.adjusted ? undefined : p.fill);
}

/** Text on a fill of the colour: white, or black where white would not read. */
export const textOn = (fill: string) => (contrast(fill, '#ffffff') >= 4.5 ? '#ffffff' : '#000000');

/**
 * A colour laid over another with an opacity, as the browser paints it (sRGB): what
 * `bg-sidebar-fg/10` on the side panel looks like.
 */
export function over(top: string, under: string, alpha: number): string {
  const [a, b] = [fromHex(top), fromHex(under)];
  return hex(a.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha))) as RGB);
}

/** The panel's text reads on the panel, on a hovered row and on the open page. */
export function panelTextContrast(text: string, panel: string): number {
  return Math.min(
    contrast(text, panel),
    contrast(text, over(text, panel, 0.1)),
    contrast(text, over(text, panel, 0.15)),
  );
}

/** The dark theme's panel is no lighter than this (the stylesheet's own dark panel and a little). */
const DARK_PANEL_MAX = luminance(fromHex('#1c2747'));

/** The panel's second text (group headings, pages not open): the text toward the panel, at 4.5:1. */
function mutedOn(text: string, panel: string): string {
  for (const pct of [72, 78, 84, 90, 95]) {
    const m = mixedWith(text, panel, pct);
    if (contrast(m, panel) >= AIM) return m;
  }
  return text;
}

/**
 * The side panel's colours in one theme. In the dark theme the panel keeps its hue but darkens
 * (as the stylesheet's own does, so it is not the brightest area of the page), and its text is
 * the chosen one if it still reads there, or a light one.
 */
export function sidebarTokens(
  s: { background: string; text: string },
  mode: 'light' | 'dark',
): Tokens {
  let panel = s.background.toLowerCase();
  let text = s.text.toLowerCase();
  if (mode === 'dark') {
    if (luminance(fromHex(panel)) > DARK_PANEL_MAX) {
      let pct = 95;
      while (pct > 5 && luminance(fromHex(mixed(panel, 'black', pct))) > DARK_PANEL_MAX) pct -= 5;
      panel = mixed(panel, 'black', pct);
    }
    // The chosen text only where it reads with a margin, hovered and open rows included: the
    // person chose it for the light theme and cannot fix this one.
    if (panelTextContrast(text, panel) < AIM) text = '#e8ecf6';
  }
  const muted = mutedOn(text, panel);
  return { 'navy-fill': panel, 'sidebar-fg': text, sidebar: muted, 'sidebar-brand': muted };
}

/** Corners for each choice; `standard` leaves the stylesheet's. */
const RADIUS_TOKENS: Record<Radius, Tokens> = {
  square: { '--radius-md': '2px', '--radius-lg': '3px', '--radius-xl': '4px' },
  small: { '--radius-md': '4px', '--radius-lg': '6px', '--radius-xl': '8px' },
  standard: {},
  round: { '--radius-md': '12px', '--radius-lg': '16px', '--radius-xl': '20px' },
};

/** Everything the organisation's theme changes in one theme (see `Tokens`). */
export function themeTokens(theme: Partial<OrgTheme>, mode: 'light' | 'dark'): Tokens {
  const out: Tokens = theme.primary
    ? primaryTokens(theme.primary, mode)
    : accentTokens(theme.accent ?? 'brand', mode);
  if (theme.accentColor) {
    out.accent = theme.accentColor.toLowerCase();
    out['on-accent'] = textOn(theme.accentColor);
  }
  if (theme.sidebar) Object.assign(out, sidebarTokens(theme.sidebar, mode));
  if (theme.radius) Object.assign(out, RADIUS_TOKENS[theme.radius]);
  return out;
}

export interface ContrastFailure {
  mode: 'light' | 'dark';
  pair: string;
  ratio: number;
}

/**
 * Every text/background pair a theme creates, in both themes, against the 4.5:1 that text
 * needs. An empty list means the theme keeps the interface's accessibility.
 */
export function checkTheme(theme: Partial<OrgTheme>): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  const need = (mode: 'light' | 'dark', pair: string, fg: string, bg: string, min = 4.5) => {
    const ratio = contrast(fg, bg);
    if (ratio < min) out.push({ mode, pair, ratio: Math.round(ratio * 100) / 100 });
  };
  for (const mode of ['light', 'dark'] as const) {
    const t = themeTokens(theme, mode);
    const { card, ground } = SURFACES[mode];
    // The blue as it ships has no overrides: the stylesheet's own values are checked by its tests.
    if (t['indigo-600']) {
      need(mode, 'white on the button (indigo-600)', '#ffffff', t['indigo-600']);
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
    }
    if (t['navy-fill']) {
      const panel = t['navy-fill'];
      const fg = t['sidebar-fg'] ?? '#ffffff';
      need(mode, 'text on the side panel', fg, panel);
      need(mode, 'second text on the side panel', t.sidebar!, panel);
      // A row under the pointer, and the open page, are the text over a little of itself.
      need(mode, 'text on a hovered row of the side panel', fg, over(fg, panel, 0.1));
      need(mode, 'text on the open page in the side panel', fg, over(fg, panel, 0.15));
    }
    if (t.accent) need(mode, 'text on the accent', t['on-accent']!, t.accent);
  }
  return out;
}

/** `checkTheme` for an accent of the palette alone. */
export function checkAccent(accent: Accent): ContrastFailure[] {
  return checkTheme({ accent });
}
