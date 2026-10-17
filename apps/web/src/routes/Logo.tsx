/**
 * The WanSurvey logo: a W drawn as two joined ticks on a rounded tile, and the name in two
 * colours. `onFill` is for the navy side panel (brand-blue tile, white and light blue text);
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
        className={onFill ? 'fill-indigo-600' : 'fill-navy-fill dark:fill-indigo-600'}
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
      <span className={onFill ? 'text-on-fill' : 'text-navy'}>Wan</span>
      <span className={onFill ? 'text-[#9cbcf5]' : 'text-indigo-ink-600'}>Survey</span>
    </span>
  );
}
