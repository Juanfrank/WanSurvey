import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, PinIcon } from './icons.js';

function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage may be unavailable; the choice just isn't remembered.
  }
}

/** Whether a media query matches, following changes. */
export function useMedia(query: string) {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** A boolean remembered on this device (localStorage), with a default when nothing is saved. */
export function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => readFlag(key, fallback));
  const set = (v: boolean) => {
    setValue(v);
    writeFlag(key, v);
  };
  return [value, set] as const;
}

export interface DrawerState {
  /** Pinned open as a column beside the content (on a wide screen). */
  inline: boolean;
  pinned: boolean;
  setPinned(v: boolean): void;
  /** Collapsed to a rail, the pane is open over the content. */
  open: boolean;
  /** Opened on purpose (click or shortcut), not just by pointing at the rail. */
  held: boolean;
  /** Opens (and keeps open until Escape, a click elsewhere or focus leaving) or closes it. */
  setOpen(v: boolean): void;
  /** Opens it while the pointer is on the rail; leaving closes it unless it was opened on purpose. */
  peek(v: boolean): void;
}

/**
 * State of a side pane that is pinned beside the content or collapsed to a rail whose pane
 * opens over the content. Pinned by default on wide screens; on narrow ones it is always a
 * rail. The choice is remembered on the device.
 */
export function useDrawer(storageKey: string, pinnedDefault = true): DrawerState {
  const wide = useMedia('(min-width: 1024px)');
  const [pinned, setPinned] = useStoredFlag(storageKey, pinnedDefault);
  const [state, setState] = useState({ open: false, held: false });
  const inline = wide && pinned;
  return {
    inline,
    pinned,
    setPinned: (v) => {
      setPinned(v);
      setState({ open: false, held: false });
    },
    open: !inline && state.open,
    held: state.held,
    setOpen: (v) => setState({ open: v, held: v }),
    peek: (v) =>
      setState((s) => (v ? { ...s, open: true } : s.held ? s : { open: false, held: false })),
  };
}

/**
 * A side pane. Pinned, it is a sticky column beside the content. Collapsed, it is a slim sticky
 * rail (icon, title, count) that stays beside the content; pointing at it, clicking it or a
 * shortcut opens the pane over the content next to the rail, without moving the content. It
 * closes when the pointer leaves, on Escape, on a click elsewhere or when focus leaves it.
 * The content stays mounted while collapsed, so it keeps its state.
 */
export function SideDrawer({
  id,
  drawer,
  side,
  label,
  icon,
  badge,
  className = '',
  children,
}: {
  id: string;
  drawer: DrawerState;
  side: 'left' | 'right';
  label: string;
  icon: ReactNode;
  badge?: number;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { inline, open } = drawer;

  // A click elsewhere closes the pane.
  useEffect(() => {
    if (inline || !open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) drawer.setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [inline, open, drawer]);
  useEffect(() => () => clearTimeout(leave.current), []);

  const pin = (
    <button
      type="button"
      data-pin
      aria-pressed={drawer.pinned}
      title={drawer.pinned ? t('app.unpin') : t('app.pin')}
      aria-label={`${drawer.pinned ? t('app.unpin') : t('app.pin')}: ${label}`}
      onClick={() => {
        drawer.setPinned(!drawer.pinned);
        // The control moves (into the column, or onto the rail): keep focus with it.
        requestAnimationFrame(() =>
          (
            document.querySelector<HTMLElement>(`#${id} [data-pin]`) ??
            document.querySelector<HTMLElement>(`[aria-controls="${id}"]`)
          )?.focus(),
        );
      }}
      className={`hidden h-8 w-8 place-items-center rounded-full lg:grid ${
        drawer.pinned
          ? 'bg-indigo-600 text-white hover:bg-indigo-500'
          : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
      }`}
    >
      <PinIcon className="h-4 w-4" />
    </button>
  );

  if (inline)
    return (
      <aside
        id={id}
        aria-label={label}
        className={`sticky top-4 flex max-h-[calc(100vh-2rem)] min-w-0 flex-col gap-1 self-start overflow-y-auto ${className}`}
      >
        <div className="no-print flex justify-end">{pin}</div>
        {children}
      </aside>
    );

  return (
    <aside
      ref={box}
      aria-label={label}
      className="no-print sticky top-4 z-20 h-[calc(100vh-2rem)] w-12 self-start"
      onMouseEnter={() => {
        clearTimeout(leave.current);
        drawer.peek(true);
      }}
      onMouseLeave={() => {
        clearTimeout(leave.current);
        leave.current = setTimeout(() => drawer.peek(false), 160);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drawer.setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open && !e.defaultPrevented) {
          e.preventDefault();
          drawer.setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <div className="flex h-full flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white py-3 shadow-sm">
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-label={label}
          title={label}
          // Pointing opened it: a click keeps it open; otherwise a click opens or closes it.
          onClick={() => drawer.setOpen(!(open && drawer.held))}
          className={`grid h-9 w-9 place-items-center rounded-lg ${
            open ? 'bg-indigo-600 text-white' : 'text-navy hover:bg-indigo-50 hover:text-indigo-600'
          }`}
        >
          {icon}
        </button>
        {badge ? (
          <span className="rounded-full bg-amber-100 px-2 text-xs font-bold text-amber-900">
            {badge}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className="rotate-180 text-xs font-semibold uppercase tracking-wider text-slate-600 [writing-mode:vertical-rl]"
        >
          {label}
        </span>
      </div>
      <div
        id={id}
        hidden={!open}
        className={`absolute top-0 flex h-full w-[min(26rem,calc(100vw-5rem))] flex-col gap-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-card ${
          side === 'left' ? 'left-full ml-2' : 'right-full mr-2'
        } ${className}`}
      >
        <div className="flex items-center justify-end gap-1">
          {pin}
          <button
            type="button"
            aria-label={`${t('app.close')}: ${label}`}
            title={t('app.close')}
            onClick={() => {
              drawer.setOpen(false);
              button.current?.focus();
            }}
            className="grid h-8 w-8 place-items-center rounded-full text-slate-600 hover:bg-indigo-50 hover:text-indigo-600"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </aside>
  );
}
