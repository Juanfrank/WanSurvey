import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from './icons.js';

/**
 * BulkBar: the actions on the rows ticked in a list, in a bar fixed at the bottom of the
 * screen. It shows only while something is ticked (`count > 0`), so the list starts right under
 * its filters instead of under a block of controls that do nothing yet.
 *
 * - It is a named region (`role="region"`, `label`: "3 cases selected"), so screen readers can
 *   jump to it; the visible text (`children` first) says the same.
 * - It keeps its own height free at the end of the list (a spacer where it is placed), so the
 *   last row and the pagination are never under it: put it after the pagination. If it comes up
 *   while the end of the list is in view, the page moves up by its height so the pagination
 *   shows above it.
 * - It sits between the side panel and the right edge (the app's `--side-w`, `--pane-left`,
 *   `--pane-right`), the whole width on a phone; its controls wrap there.
 * - `onClear` adds a ✕ that unticks everything.
 * - When an action clears the selection while the focus is in the bar (or in a dialog opened
 *   from it), the focus goes to the bar's place, or to `focusOnHide()`, not to the page's top.
 *
 *   <BulkBar
 *     count={selected.size}
 *     label={t('cases.list.selectedRegion', { count: selected.size })}
 *     onClear={() => setSelected(new Set())}
 *   >
 *     <span>{t('cases.list.selected', { count: selected.size })}</span>
 *     <Button size="sm" onClick={assign}>{t('cases.list.assign')}</Button>
 *     <button className={smallBtn} onClick={unassign}>{t('cases.list.unassign')}</button>
 *   </BulkBar>
 */
export function BulkBar({
  count,
  label,
  onClear,
  focusOnHide,
  children,
}: {
  /** How many rows are ticked; nothing shows at 0. */
  count: number;
  /** Names the region: how many are selected, in words ("3 cases selected"). */
  label: string;
  /** Unticks everything (shows a ✕ at the end). */
  onClear?: () => void;
  /**
   * Where the focus goes when the bar goes away with it inside (an action cleared the
   * selection); by default, the bar's place in the page (after the pagination).
   */
  focusOnHide?: () => HTMLElement | null | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  // Whether the keyboard focus is in the bar (or in a dialog opened from it).
  const focused = useRef(false);
  const [height, setHeight] = useState(0);
  const shown = count > 0;
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [shown]);
  // When the bar comes up over the end of the list (the pagination in view, under it), the page
  // moves up by the overlap, so what the spacer keeps free is in view at once.
  const revealed = useRef(false);
  useEffect(() => {
    if (!shown) {
      revealed.current = false;
      return;
    }
    // Wait for this showing's own height (the state may still hold the last showing's), so the
    // spacer under the list is already that tall.
    if (revealed.current || !height || height !== bar.current?.offsetHeight) return;
    revealed.current = true;
    const end = spacer.current?.getBoundingClientRect().top;
    if (end === undefined) return;
    const free = window.innerHeight - (height + 24);
    if (end > free && end <= window.innerHeight) window.scrollBy({ top: end - free });
  }, [shown, height]);
  // Followed on the document: removing the focused button fires no event to rely on.
  useEffect(() => {
    if (!shown) return;
    const on = (e: FocusEvent) => {
      focused.current = !!bar.current?.contains(e.target as Node);
    };
    document.addEventListener('focusin', on);
    return () => document.removeEventListener('focusin', on);
  }, [shown]);
  // An action that clears the selection removes the bar with the button just pressed: the
  // focus would fall to the top of the page. It goes to where the bar was instead.
  useLayoutEffect(() => {
    if (shown || !focused.current) return;
    focused.current = false;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost) (focusOnHide?.() ?? anchor.current)?.focus();
  }, [shown, focusOnHide]);
  const place = <span ref={anchor} tabIndex={-1} className="sr-only" data-bulk-anchor="" />;
  if (!shown) return place;
  return (
    <>
      {place}
      {/* The bar's height (and its gap from the bottom) kept free under the list. */}
      <div ref={spacer} aria-hidden="true" data-bulk-spacer="" style={{ height: height + 24 }} />
      <div
        ref={bar}
        role="region"
        aria-label={label}
        data-bulk-bar=""
        className="no-print fixed inset-x-3 bottom-3 z-30 min-[900px]:left-[calc(var(--side-w,0px)+var(--pane-left,0px)+2rem)] min-[900px]:right-[calc(var(--pane-right,0px)+2rem)]"
      >
        <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-1 rounded-xl border border-indigo-200 bg-white px-2.5 py-2 text-sm shadow-[0_12px_32px_rgb(15_23_42/0.25)] [&>button]:px-2.5">
          {children}
          {onClear ? (
            <button
              type="button"
              onClick={onClear}
              aria-label={t('ui.clearSelection')}
              title={t('ui.clearSelection')}
              className="ml-auto grid h-8 w-8 flex-none place-items-center rounded-full px-0! text-slate-600 hover:bg-slate-100 hover:text-navy"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
