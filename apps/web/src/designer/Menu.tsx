import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export type MenuEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      /** Shortcut shown on the right (not bound here). */
      shortcut?: string;
      /** A short line under the label. */
      hint?: string;
      disabled?: boolean;
      /** For a choice menu: marks the current value (menuitemradio). */
      checked?: boolean;
      /** Keeps the menu open (e.g. it swaps the menu's content). */
      keepOpen?: boolean;
      onSelect(): void;
    }
  | { type: 'group'; label: string; items: MenuEntry[] }
  | { type: 'separator' };

/**
 * A popup menu (WAI-ARIA menu pattern) at a point or under an element: arrow keys, Home/End and
 * the first letter move, Enter or Space picks, Escape or a click outside closes. Used for the
 * item type picker, the add buttons and the outline's context menu, so all three list the same
 * choices the same way.
 */
export function Menu({
  label,
  entries,
  at,
  onClose,
  minWidth = 240,
}: {
  label: string;
  entries: MenuEntry[];
  /** Viewport coordinates of the top-left corner (clamped to stay on screen). */
  at: { x: number; y: number };
  onClose(): void;
  minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8));
    const y =
      at.y + r.height > window.innerHeight - 8
        ? Math.max(8, window.innerHeight - r.height - 8)
        : at.y;
    setPos({ x, y });
  }, [at.x, at.y, entries]);

  // Focus the checked item, or the first one, whenever the content changes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target =
      el.querySelector<HTMLElement>(
        '[role^=menuitem][aria-checked=true]:not([aria-disabled=true])',
      ) ?? el.querySelector<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])');
    target?.focus();
  }, [entries]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const blur = () => onClose();
    document.addEventListener('mousedown', down);
    window.addEventListener('resize', blur);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('resize', blur);
    };
  }, [onClose]);

  const focusables = () => [
    ...(ref.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])') ??
      []),
  ];
  const onKeyDown = (e: KeyboardEvent) => {
    const list = focusables();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      const after = [...list.slice(i + 1), ...list.slice(0, i + 1)];
      after.find((el) => el.textContent?.trim().toLowerCase().startsWith(k))?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const pick = (it: Extract<MenuEntry, { type: 'item' }>) => {
    if (it.disabled) return;
    if (!it.keepOpen) onClose();
    it.onSelect();
  };

  const render = (list: MenuEntry[], depth = 0): ReactNode =>
    list.map((e, n) => {
      if (e.type === 'separator')
        return <div key={`s${n}`} role="separator" className="my-1 border-t border-slate-200" />;
      if (e.type === 'group')
        return (
          <div key={`g${e.label}`} role="group" aria-label={e.label} className="py-0.5">
            <div
              aria-hidden
              className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              {e.label}
            </div>
            {render(e.items, depth + 1)}
          </div>
        );
      return (
        <div
          key={e.id}
          role={e.checked !== undefined ? 'menuitemradio' : 'menuitem'}
          aria-checked={e.checked}
          aria-disabled={e.disabled || undefined}
          tabIndex={-1}
          data-menu-item={e.id}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-indigo-50 focus:bg-indigo-50 aria-checked:font-semibold aria-disabled:cursor-default aria-disabled:opacity-40"
          onClick={() => pick(e)}
          onKeyDown={(k) => {
            if (k.key === 'Enter' || k.key === ' ') {
              k.preventDefault();
              k.stopPropagation();
              pick(e);
            }
          }}
        >
          <span aria-hidden className="flex w-5 shrink-0 justify-center text-slate-600">
            {e.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{e.label}</span>
            {e.hint ? (
              <span className="block truncate text-xs text-slate-500">{e.hint}</span>
            ) : null}
          </span>
          {e.checked ? (
            <span aria-hidden className="text-indigo-ink-700">
              ✓
            </span>
          ) : null}
          {e.shortcut ? (
            <kbd className="shrink-0 font-sans text-xs text-slate-500">{e.shortcut}</kbd>
          ) : null}
        </div>
      );
    });

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
      style={{ left: pos.x, top: pos.y, minWidth }}
      data-testid="menu"
    >
      {render(entries)}
    </div>
  );
}

/** Where to open a menu under a button. */
export function below(el: HTMLElement | null): { x: number; y: number } {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, y: r.bottom + 4 } : { x: 16, y: 16 };
}
