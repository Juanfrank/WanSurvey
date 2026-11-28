import { useTranslation } from 'react-i18next';

/**
 * The WanSurvey logo: a W drawn as two joined ticks on a rounded tile, and the name in two
 * colours. `onFill` is for the side panel (tile in the main colour, the panel's text colours);
 * otherwise it follows the page's theme.
 */
export function LogoMark({
  onFill = false,
  className = '',
}: {
  onFill?: boolean;
  className?: string;
}) {
  return (
    <svg viewBox="6 6 80 80" aria-hidden="true" focusable="false" className={className}>
      <rect
        x="6"
        y="6"
        width="80"
        height="80"
        rx="20"
        className={onFill ? 'fill-indigo-600' : 'fill-[#0a2e7a] dark:fill-indigo-600'}
      />
      <path
        d="M19 42 L31 62 L46 33 L58 62 L75 26"
        fill="none"
        stroke="#fff"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M58 62 L75 26"
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        className={onFill ? 'stroke-[#9cbcf5]' : 'stroke-[#4d8bff] dark:stroke-[#9cbcf5]'}
      />
    </svg>
  );
}

export function LogoName({
  onFill = false,
  className = '',
}: {
  onFill?: boolean;
  className?: string;
}) {
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      <span className={onFill ? 'text-sidebar-fg' : 'text-navy'}>Wan</span>
      <span className={onFill ? 'text-sidebar-brand' : 'text-indigo-ink-600'}>Survey</span>
    </span>
  );
}

/**
 * The organisation's logo as uploaded, on a white plate: a logo is usually drawn for paper, and
 * would vanish on a dark side panel or in the dark theme. Its description is the image's text.
 */
export function OrgLogoImage({
  logo,
  className = '',
}: {
  logo: { url: string; alt: string };
  className?: string;
}) {
  return (
    <span className={`inline-flex flex-none items-center rounded-md bg-[#ffffff] p-1 ${className}`}>
      <img src={logo.url} alt={logo.alt} className="h-full w-auto max-w-full object-contain" />
    </span>
  );
}

/** "with WanSurvey": the app's logo as a small sub-logo, under or below the organisation's. */
export function WithWanSurvey({
  onFill = false,
  markOnly = false,
  className = '',
}: {
  onFill?: boolean;
  /** Only the mark (the compact side panel); its name stays for screen readers. */
  markOnly?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <p
      className={`flex items-center gap-1.5 text-xs ${onFill ? 'text-sidebar' : 'text-slate-600'} ${className}`}
      data-testid="app-sublogo"
    >
      <span className={markOnly ? 'sr-only' : ''}>{t('app.with')}</span>
      <LogoMark onFill={onFill} className="h-4 w-4 flex-none" />
      <LogoName onFill={onFill} className={markOnly ? 'sr-only' : 'text-xs'} />
    </p>
  );
}
