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
}: {
  title: ReactNode;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
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
      <h2 id={`${id}-title`} className="mb-4 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
