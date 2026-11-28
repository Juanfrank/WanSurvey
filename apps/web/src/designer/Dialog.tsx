import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal dialog on the native <dialog> element: focus is trapped and Escape closes it.
 * Focus returns to whatever had it before.
 */
export function Dialog({
  title,
  children,
  onClose,
  wide,
  header,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
  /** Shown under the title; both stay in view while the rest scrolls. */
  header?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const previous = document.activeElement as HTMLElement | null;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      className={`m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-900/40 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {header ? (
        <div
          className="sticky -top-6 z-10 -mx-6 -mt-6 mb-4 border-b border-slate-200 bg-white px-6 pt-6 pb-3"
          data-sticky-header=""
        >
          <h2 id={`${id}-title`} className="mb-2 text-lg font-semibold">
            {title}
          </h2>
          {header}
        </div>
      ) : (
        <h2 id={`${id}-title`} className="mb-4 text-lg font-semibold">
          {title}
        </h2>
      )}
      {children}
    </dialog>
  );
}
