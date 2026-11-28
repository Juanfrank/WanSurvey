import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ACCENTS,
  APP_LOGO_PLACES,
  RADII,
  THEME_DEFAULTS,
  accentTokens,
  appLogoPlace,
  checkTheme,
  orgTheme,
  panelTextContrast,
  primaryFill,
  themeTokens,
  type Accent,
  type AppLogoPlace,
  type ContrastFailure,
  type OrgTheme,
  type Radius,
  type ThemeDefault,
  type Tokens,
} from '@wansurvey/schema';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError, upload } from '../api.js';
import { controlCls, inputCls, smallBtn } from '../designer/fields.js';
import { InfoTip } from '../cases/samplingControls.js';
import { LogoMark, LogoName, OrgLogoImage, WithWanSurvey } from '../routes/Logo.js';
import { tokenVar } from '../theme.js';
import { Button, Card, ErrorText } from '../routes/ui.js';

export interface TenantLook {
  name: string;
  branding?: unknown;
  /** The organisation's logo: its description and when it changed. */
  logo?: { alt: string; updatedAt: string } | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO_MAX = 512 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** The stylesheet's own values of everything a theme can change, so the preview starts clean. */
const BLUE: Tokens = {
  'indigo-400': '#4d82f0',
  'indigo-500': '#2a6be8',
  'indigo-600': '#0050dd',
  'indigo-700': '#0a42b8',
  'indigo-800': '#0a2e7a',
  'indigo-900': '#06215c',
  'indigo-950': '#041640',
  'sidebar-fg': '#ffffff',
  'sidebar-brand': '#9cbcf5',
  sidebar: '#afc0e8',
  '--radius-md': '8px',
  '--radius-lg': '10px',
  '--radius-xl': '12px',
};
const BASE: Record<'light' | 'dark', Tokens> = {
  light: {
    ...BLUE,
    'indigo-50': '#eef3fd',
    'indigo-100': '#e1ebfc',
    'indigo-200': '#c2d5f8',
    'indigo-300': '#7ea5f2',
    'indigo-ink-600': '#0050dd',
    'indigo-ink-700': '#0a42b8',
    'indigo-ink-800': '#0a2e7a',
    'indigo-ink-900': '#06215c',
    'indigo-ink-950': '#041640',
    navy: '#0a2e7a',
    'navy-2': '#06215c',
    'navy-fill': '#0a2e7a',
  },
  dark: {
    ...BLUE,
    'indigo-50': '#16233f',
    'indigo-100': '#1c2d52',
    'indigo-200': '#24407a',
    'indigo-300': '#3b5ca8',
    'indigo-ink-600': '#8db6ff',
    'indigo-ink-700': '#a9c6ff',
    'indigo-ink-800': '#bbd3ff',
    'indigo-ink-900': '#d2e1ff',
    'indigo-ink-950': '#e6eeff',
    navy: '#bbd3ff',
    'navy-2': '#9cbcf5',
    'navy-fill': '#0e1730',
  },
};

/** The custom properties of a theme for a part of the page (the preview), in one theme. */
export function previewVars(theme: Partial<OrgTheme>, mode: 'light' | 'dark'): CSSProperties {
  const t = { ...BASE[mode], ...themeTokens(theme, mode) };
  // The accent follows the main colour unless chosen; on <html> the stylesheet does that itself.
  t.accent ??= t['indigo-600']!;
  t['on-accent'] ??= '#ffffff';
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [tokenVar(k), v])) as CSSProperties;
}

/** The theme the page is in now (the person's, the organisation's or the device's), kept up to date. */
function usePageTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [mode, setMode] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const o = new MutationObserver(() => setMode(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => o.disconnect();
  }, []);
  return mode;
}

/** A colour: the browser's picker and the same value as text, checked as #rrggbb. */
function ColourField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const valid = HEX.test(value);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <span className="flex items-center gap-2">
        <input
          type="color"
          aria-label={t('admin.org.appearance.picker', { name: label })}
          className="h-9 w-12 flex-none cursor-pointer rounded border border-slate-300 bg-white"
          value={valid ? value.toLowerCase() : '#000000'}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          id={id}
          className={`${controlCls} w-28 py-1.5 font-mono`}
          value={value}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : `${id}-error`}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </span>
      {valid ? null : (
        <span id={`${id}-error`} className="text-xs text-red-ink-800">
          {t('admin.org.appearance.invalidHex')}
        </span>
      )}
    </div>
  );
}

/** What a contrast failure means for the person choosing, in words. */
function problemText(t: TFunction, f: ContrastFailure) {
  const ratio = f.ratio.toFixed(2);
  const mode = t(`app.themes.${f.mode}`).toLowerCase();
  if (f.pair.includes('side panel'))
    return t('admin.org.appearance.problems.sidebar', { ratio, mode });
  if (f.pair.includes('accent')) return t('admin.org.appearance.problems.accent', { ratio, mode });
  return t('admin.org.appearance.problems.other', { ratio, mode });
}

/**
 * The organisation's look: default theme, main colour, accent, side panel, corners, its logo and
 * where WanSurvey's goes, with a live preview. Colours are only defaults: a person who picks their
 * own theme in the account menu keeps it. Every colour is checked (WCAG AA, 4.5:1 for text) in
 * both themes; a main colour too light for white text is darkened, and the colour used is shown.
 */
export function OrgAppearance({
  tenant,
  singleTenant,
}: {
  tenant: TenantLook;
  singleTenant: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const current = orgTheme(tenant.branding);
  const [def, setDef] = useState<ThemeDefault>(current.default);
  const [main, setMain] = useState<Accent | 'own'>(current.primary ? 'own' : current.accent);
  const [primary, setPrimary] = useState(current.primary ?? '#0050dd');
  const [accentOwn, setAccentOwn] = useState(!!current.accentColor);
  const [accentColor, setAccentColor] = useState(current.accentColor ?? '#0050dd');
  const [sidebarOwn, setSidebarOwn] = useState(!!current.sidebar);
  const [sbBg, setSbBg] = useState(current.sidebar?.background ?? '#0a2e7a');
  const [sbText, setSbText] = useState(current.sidebar?.text ?? '#ffffff');
  const [radius, setRadius] = useState<Radius>(current.radius ?? 'standard');
  const [appLogo, setAppLogo] = useState<AppLogoPlace | ''>(current.appLogo ?? '');
  const [alt, setAlt] = useState(tenant.logo?.alt ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setAlt(tenant.logo?.alt ?? ''), [tenant.logo?.alt]);

  const coloursValid = [
    main === 'own' ? primary : '#000000',
    accentOwn ? accentColor : '#000000',
    sidebarOwn ? sbBg : '#000000',
    sidebarOwn ? sbText : '#000000',
  ].every((c) => HEX.test(c));
  const theme: OrgTheme = {
    default: def,
    accent: main === 'own' ? 'brand' : main,
    ...(main === 'own' ? { primary } : {}),
    ...(accentOwn ? { accentColor } : {}),
    ...(sidebarOwn ? { sidebar: { background: sbBg, text: sbText } } : {}),
    ...(radius !== 'standard' ? { radius } : {}),
    ...(appLogo ? { appLogo } : {}),
  };
  const problems = coloursValid ? checkTheme(theme) : [];
  const fill = main === 'own' && HEX.test(primary) ? primaryFill(primary) : null;
  const altChanged = !!tenant.logo && alt.trim() !== tenant.logo.alt;
  const altMissing = !!tenant.logo && !alt.trim();
  const json = JSON.stringify(theme);
  useEffect(() => setSaved(null), [json]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['tenant'] });
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api('/tenant', {
        method: 'PATCH',
        body: { branding: { theme }, ...(altChanged ? { logoAlt: alt.trim() } : {}) },
      }),
    onSuccess: async () => {
      setSaved('admin.org.appearance.saved');
      await refresh();
    },
  });
  const sendLogo = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('alt', alt.trim());
      form.append('file', f);
      return upload('/tenant/logo', form, 'PUT');
    },
    onSuccess: async () => {
      setLogoError(null);
      setSaved('admin.org.appearance.logoSaved');
      await refresh();
    },
    onError: (e) =>
      setLogoError(
        e instanceof ApiError && e.status === 413
          ? t('admin.org.appearance.logoTooLarge')
          : e instanceof ApiError && e.status === 422
            ? t('admin.org.appearance.logoType')
            : t('admin.org.appearance.logoFailed'),
      ),
  });
  const removeLogo = useMutation({
    mutationFn: () => api('/tenant/logo', { method: 'DELETE' }),
    onSuccess: async () => {
      setLogoError(null);
      setSaved('admin.org.appearance.logoRemoved');
      await refresh();
    },
    onError: () => setLogoError(t('admin.org.appearance.logoRemoveFailed')),
  });
  const pick = (f: File) => {
    if (!alt.trim()) return setLogoError(t('admin.org.appearance.logoAltRequired'));
    if (!LOGO_TYPES.includes(f.type)) return setLogoError(t('admin.org.appearance.logoType'));
    if (f.size > LOGO_MAX) return setLogoError(t('admin.org.appearance.logoTooLarge'));
    sendLogo.mutate(f);
  };

  const logo = tenant.logo
    ? {
        url: `/api/v1/tenant/logo?v=${Date.parse(tenant.logo.updatedAt)}`,
        alt: alt.trim() || tenant.logo.alt,
      }
    : null;
  const defaultPlace = appLogoPlace(undefined, singleTenant);
  const place = appLogoPlace(theme, singleTenant);
  const mode = usePageTheme();
  const swatch = (a: Accent) => accentTokens(a, 'light')['indigo-600'] ?? '#0050dd';
  const legend = 'mb-1 text-sm font-medium text-slate-700';
  const choice =
    'flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50';

  return (
    <Card className="p-5!">
      <form
        className="flex flex-col gap-4"
        data-testid="org-appearance"
        onSubmit={(e) => {
          e.preventDefault();
          if (coloursValid && !problems.length && !altMissing) save.mutate();
        }}
      >
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold">{t('admin.org.appearance.title')}</h2>
          <InfoTip
            id="org-appearance-info"
            term={t('admin.org.appearance.title')}
            text={t('admin.org.appearance.hint')}
          />
        </div>

        {/* The logo first: it is sent on its own, as soon as it is chosen. */}
        <section aria-labelledby="org-logo" className="flex flex-col gap-2">
          <h3 id="org-logo" className="text-base font-semibold">
            {t('admin.org.appearance.logo')}
          </h3>
          <p className="text-sm text-slate-600">{t('admin.org.appearance.logoHelp')}</p>
          <label className="flex max-w-md flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">
              {t('admin.org.appearance.logoAlt')}
            </span>
            <input
              className={`${inputCls} py-2`}
              value={alt}
              maxLength={200}
              required={!!tenant.logo}
              aria-describedby="org-logo-alt-help"
              onChange={(e) => {
                setAlt(e.target.value);
                setSaved(null);
              }}
            />
            <span id="org-logo-alt-help" className="text-xs text-slate-600">
              {t('admin.org.appearance.logoAltHelp')}
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            {logo ? (
              <OrgLogoImage logo={logo} className="h-14 max-w-[14rem] border border-slate-200" />
            ) : (
              <span className="text-sm text-slate-600">{t('admin.org.appearance.noLogo')}</span>
            )}
            <input
              ref={file}
              type="file"
              accept={LOGO_TYPES.join(',')}
              className="sr-only"
              aria-label={t('admin.org.appearance.chooseLogo')}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pick(f);
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={sendLogo.isPending}
              onClick={() => {
                if (!alt.trim()) setLogoError(t('admin.org.appearance.logoAltRequired'));
                else file.current?.click();
              }}
            >
              {tenant.logo ? t('admin.org.appearance.replace') : t('admin.org.appearance.upload')}
            </Button>
            {tenant.logo ? (
              <button
                type="button"
                className={smallBtn}
                disabled={removeLogo.isPending}
                onClick={() => {
                  if (window.confirm(t('admin.org.appearance.confirmRemove'))) removeLogo.mutate();
                }}
              >
                {t('admin.org.appearance.remove')}
              </button>
            ) : null}
          </div>
          {logoError ? <ErrorText>{logoError}</ErrorText> : null}
        </section>

        <fieldset className="flex flex-col gap-2">
          <legend className={legend}>{t('admin.org.appearance.appLogo')}</legend>
          <div className="flex flex-wrap gap-3">
            {(['', ...APP_LOGO_PLACES] as const).map((p) => (
              <label key={p || 'default'} className={choice}>
                <input
                  type="radio"
                  name="org-app-logo"
                  checked={appLogo === p}
                  onChange={() => setAppLogo(p)}
                />
                {p
                  ? t(`admin.org.appearance.appLogos.${p}`)
                  : t('admin.org.appearance.appLogoDefault', {
                      place: t(`admin.org.appearance.appLogos.${defaultPlace}`),
                    })}
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-600">{t(`admin.org.appearance.appLogoHelp.${place}`)}</p>
        </fieldset>

        <label className="flex max-w-xs flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            {t('admin.org.appearance.theme')}
          </span>
          <select
            className={`${inputCls} py-2`}
            value={def}
            onChange={(e) => setDef(e.target.value as ThemeDefault)}
          >
            {THEME_DEFAULTS.map((v) => (
              <option key={v} value={v}>
                {t(`app.themes.${v}`)}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className={legend}>{t('admin.org.appearance.accent')}</legend>
          <div className="flex flex-wrap gap-3">
            {[...ACCENTS, 'own' as const].map((a) => (
              <label key={a} className={choice}>
                <input
                  type="radio"
                  name="org-accent"
                  checked={main === a}
                  onChange={() => setMain(a)}
                />
                <span
                  aria-hidden="true"
                  className="h-5 w-5 rounded-full border border-slate-300"
                  style={{
                    background: a === 'own' ? (HEX.test(primary) ? primary : '#ffffff') : swatch(a),
                  }}
                />
                {t(`admin.org.appearance.accents.${a}`)}
              </label>
            ))}
          </div>
          {main === 'own' ? (
            <div className="flex flex-col gap-2">
              <ColourField
                id="org-primary"
                label={t('admin.org.appearance.primary')}
                value={primary}
                onChange={setPrimary}
              />
              {fill?.adjusted ? (
                <p
                  className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-ink-900"
                  data-testid="primary-adjusted"
                >
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 flex-none rounded-sm border border-slate-300"
                    style={{ background: fill.fill }}
                  />
                  {t('admin.org.appearance.adjusted', { used: fill.fill, chosen: primary })}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className={legend}>{t('admin.org.appearance.accentColor')}</legend>
          <div className="flex flex-wrap gap-3">
            {[false, true].map((own) => (
              <label key={String(own)} className={choice}>
                <input
                  type="radio"
                  name="org-accent-colour"
                  checked={accentOwn === own}
                  onChange={() => setAccentOwn(own)}
                />
                {t(own ? 'admin.org.appearance.accentOwn' : 'admin.org.appearance.accentSame')}
              </label>
            ))}
          </div>
          {accentOwn ? (
            <ColourField
              id="org-accent-colour"
              label={t('admin.org.appearance.accentValue')}
              value={accentColor}
              onChange={setAccentColor}
            />
          ) : null}
          <p className="text-xs text-slate-600">{t('admin.org.appearance.accentHelp')}</p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className={legend}>{t('admin.org.appearance.sidebar')}</legend>
          <div className="flex flex-wrap gap-3">
            {[false, true].map((own) => (
              <label key={String(own)} className={choice}>
                <input
                  type="radio"
                  name="org-sidebar"
                  checked={sidebarOwn === own}
                  onChange={() => setSidebarOwn(own)}
                />
                {t(
                  own ? 'admin.org.appearance.sidebarOwn' : 'admin.org.appearance.sidebarStandard',
                )}
              </label>
            ))}
          </div>
          {sidebarOwn ? (
            <div className="flex flex-wrap items-end gap-4">
              <ColourField
                id="org-sidebar-bg"
                label={t('admin.org.appearance.sidebarBg')}
                value={sbBg}
                onChange={setSbBg}
              />
              <ColourField
                id="org-sidebar-text"
                label={t('admin.org.appearance.sidebarText')}
                value={sbText}
                onChange={setSbText}
              />
              {HEX.test(sbBg) && HEX.test(sbText) ? (
                <p className="pb-2 text-sm text-slate-700" data-testid="sidebar-contrast">
                  {t('admin.org.appearance.contrast', {
                    ratio: (Math.floor(panelTextContrast(sbText, sbBg) * 10) / 10).toFixed(1),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <label className="flex max-w-xs flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            {t('admin.org.appearance.radius')}
          </span>
          <select
            className={`${inputCls} py-2`}
            value={radius}
            onChange={(e) => setRadius(e.target.value as Radius)}
          >
            {RADII.map((r) => (
              <option key={r} value={r}>
                {t(`admin.org.appearance.radii.${r}`)}
              </option>
            ))}
          </select>
        </label>

        {problems.length ? (
          <ul
            className="flex list-disc flex-col gap-1 rounded-md bg-red-50 py-2 pr-3 pl-7 text-sm text-red-ink-800"
            data-testid="theme-problems"
          >
            {[...new Set(problems.map((f) => problemText(t, f)))].map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : null}

        <section aria-labelledby="org-preview" className="flex flex-col gap-2">
          <h3 id="org-preview" className="text-base font-semibold">
            {t('admin.org.appearance.preview')}
          </h3>
          {coloursValid ? (
            <Preview
              vars={previewVars(theme, mode)}
              place={place}
              logo={logo}
              orgName={tenant.name}
            />
          ) : null}
        </section>

        {save.isError ? <ErrorText>{t('admin.org.appearance.error')}</ErrorText> : null}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={save.isPending || !coloursValid || problems.length > 0 || altMissing}
          >
            {t('admin.org.save')}
          </Button>
          <p role="status" className="text-sm text-emerald-ink-800 empty:hidden">
            {saved ? t(saved) : null}
          </p>
        </div>
      </form>
    </Card>
  );
}

/** A small side panel and page in the chosen colours, drawn with the interface's own classes. */
function Preview({
  vars,
  place,
  logo,
  orgName,
}: {
  vars: CSSProperties;
  place: AppLogoPlace;
  logo: { url: string; alt: string } | null;
  orgName: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={vars}
      className="flex min-h-48 overflow-hidden rounded-xl border border-slate-200"
      data-testid="theme-preview"
      aria-hidden="true"
    >
      <div className="flex w-44 flex-none flex-col gap-2 bg-navy-fill p-3 text-sm text-sidebar">
        <div className="flex min-h-9 items-center gap-2" data-testid="preview-logo">
          {place === 'sub' ? (
            logo ? (
              <OrgLogoImage logo={logo} className="h-9 max-w-[9rem]" />
            ) : (
              <span className="truncate font-semibold text-sidebar-fg">{orgName}</span>
            )
          ) : (
            <>
              <LogoMark onFill className="h-6 w-6 flex-none" />
              <LogoName onFill className="truncate text-sm" />
              {logo ? <OrgLogoImage logo={logo} className="h-6 max-w-[3.5rem]" /> : null}
            </>
          )}
        </div>
        <span className="rounded-lg bg-accent px-2.5 py-1.5 font-semibold text-on-accent">
          {t('app.home')}
        </span>
        <span className="rounded-lg px-2.5 py-1.5 font-medium">{t('app.projects')}</span>
        <span className="rounded-lg bg-sidebar-fg/10 px-2.5 py-1.5 font-medium text-sidebar-fg">
          {t('app.admin')}
        </span>
        {place === 'sub' ? <WithWanSurvey onFill className="mt-auto" /> : null}
      </div>
      <div className="flex flex-1 flex-col gap-3 bg-ground p-4">
        <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-card">
          <p className="font-semibold text-navy">{t('admin.org.appearance.sample.title')}</p>
          <p className="text-sm text-slate-700">
            <span className="text-indigo-ink-700 underline">
              {t('admin.org.appearance.sample.link')}
            </span>
          </p>
          <span className="self-start rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-ink-800">
            {t('admin.org.appearance.sample.chip')}
          </span>
          <span
            className="self-start rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-on-fill"
            data-testid="preview-button"
          >
            {t('admin.org.appearance.sample.button')}
          </span>
        </div>
      </div>
    </div>
  );
}
