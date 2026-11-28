import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../routes/icons.js';

/**
 * Modal dialog on the native <dialog> element: focus is trapped and Escape closes it.
 * Focus returns to whatever had it before.
 *
 * `side` lays it out as a panel against the right edge, the full height of the window (the
 * whole screen on a phone): that is the `Drawer` of `routes/Drawer.tsx`, for forms that create
 * or edit something beside the list they belong to.
 */
export function Dialog({
  title,
  children,
  onClose,
  wide,
  header,
  side,
  closeLabel,
  footer,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
  /** Shown under the title; both stay in view while the rest scrolls. */
  header?: ReactNode;
  /** A panel on the right edge instead of a box in the middle (`wide`: up to 48rem, not 28rem). */
  side?: boolean;
  /** Shows a ✕ button beside the title, named with this text. */
  closeLabel?: string;
  /** Kept at the bottom, in view while the rest scrolls (a side panel's buttons). */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const previous = document.activeElement as HTMLElement | null;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    // A side panel starts on its first field, not on the ✕ before it.
    if (side)
      d.querySelector<HTMLElement>(
        '[data-dialog-body] :is(input, select, textarea, button, [href], [tabindex]):not([disabled]):not([tabindex="-1"])',
      )?.focus();
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once, on mount
  }, []);
  const heading = (
    <div className="flex items-start justify-between gap-3">
      <h2
        id={`${id}-title`}
        className={`${header ? 'mb-2' : side ? '' : 'mb-4'} text-lg font-semibold`}
      >
        {title}
      </h2>
      {closeLabel ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="-mr-2 -mt-1 grid h-8 w-8 flex-none place-items-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-navy"
          data-dialog-close=""
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
  const box = side
    ? // The whole screen on a phone; from 640 px a panel against the right edge.
      `fixed inset-y-0 right-0 left-auto m-0 flex h-dvh max-h-dvh w-full max-w-none flex-col overflow-hidden border-l border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40 ${wide ? 'sm:max-w-3xl' : 'sm:max-w-md'}`
    : `m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-900/40 ${wide ? 'max-w-3xl' : 'max-w-lg'}`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      className={box}
      data-side={side || undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {side ? (
        <>
          <div className="flex-none border-b border-slate-200 px-5 pt-5 pb-3">
            {heading}
            {header}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-dialog-body="">
            {children}
          </div>
          {footer ? (
            <div className="flex flex-none flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
              {footer}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {header ? (
            <div
              className="sticky -top-6 z-10 -mx-6 -mt-6 mb-4 border-b border-slate-200 bg-white px-6 pt-6 pb-3"
              data-sticky-header=""
            >
              {heading}
              {header}
            </div>
          ) : (
            heading
          )}
          {children}
          {footer ? <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </>
      )}
    </dialog>
  );
}
